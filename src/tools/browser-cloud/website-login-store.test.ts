import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WebsiteLoginStoreError, WebsiteLoginTicketStore, type CreateWebsiteLoginTicket } from './website-login-store.js';
import { resolveWebsiteLoginTarget } from './website-login-policy.js';

type Item = Record<string, { S?: string; N?: string }>;
type Request = Record<string, any>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ticket = (expiresAt = 20_001): CreateWebsiteLoginTicket => ({ tokenHash: hash('raw-token-never-persisted'), owner: 'cro', ownerSubjectHash: hash('connection'), profileId: 'owned-website-profile', sessionId: 'owned-session', site: 'linkedin', profileLeaseOwner: 'owned-lease-123', expiresAt });
function fixture() {
  const rows = new Map<string, Item>(); const requests: Request[] = []; let now = 1000;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Request; requests.push(request);
    const pk = request.Key?.pk?.S ?? request.Item?.pk?.S;
    const conflict = () => new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 });
    if (request.Item) {
      if (rows.has(pk)) return conflict(); rows.set(pk, structuredClone(request.Item)); return new Response('{}');
    }
    if (request.ConsistentRead) return new Response(JSON.stringify(rows.has(pk) ? { Item: rows.get(pk) } : {}));
    const row = rows.get(pk); const values = request.ExpressionAttributeValues;
    if (request.ConditionExpression === 'attribute_not_exists(lockUntil) OR lockUntil < :now') {
      if (row?.lockUntil && Number(row.lockUntil.N) >= now) return conflict();
      rows.set(pk, { pk: { S: pk }, lockOwner: structuredClone(values[':owner']), lockUntil: structuredClone(values[':until']), expiresAtEpoch: structuredClone(values[':ttl']) });
      return new Response('{}');
    }
    if (request.ConditionExpression === 'lockOwner = :owner') {
      if (!row || row.lockOwner?.S !== values[':owner']?.S) return conflict();
      rows.delete(pk); return new Response('{}');
    }
    const expected = values[':new']?.S ?? values[':from']?.S;
    if (!row || row.phase?.S !== expected || (values[':now'] && Number(row.expiresAt?.N) <= now)) return conflict();
    row.phase = structuredClone(values[':exchanged'] ?? values[':outcome']);
    return new Response(JSON.stringify(request.ReturnValues === 'ALL_NEW' ? { Attributes: row } : {}));
  };
  const store = new WebsiteLoginTicketStore({ tableName: 'synthetic-browser', region: 'us-east-1', fetchImpl, resolveCredentials: async () => ({ accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' }), now: () => now });
  return { store, rows, requests, setNow: (value: number) => { now = value; } };
}

test('website handoff stores only hashed token in a separate namespace with exact owner/site and TTL', async () => {
  const { store, rows, requests } = fixture(); const input = ticket();
  await store.create(input);
  const row = rows.get(`WEBSITE_LOGIN#${input.tokenHash}`)!;
  assert.equal(row.owner?.S, input.owner); assert.equal(row.site?.S, 'linkedin');
  assert.equal(row.ownerSubjectHash?.S, input.ownerSubjectHash); assert.equal(row.profileId?.S, input.profileId); assert.equal(row.sessionId?.S, input.sessionId);
  assert.equal(row.expiresAtEpoch?.N, '21'); assert.equal(row.phase?.S, 'NEW');
  assert.equal(JSON.stringify(row).includes('raw-token-never-persisted'), false);
  assert.equal(requests[0]?.ConditionExpression, 'attribute_not_exists(pk)');
  await assert.rejects(store.create(input), (error: unknown) => error instanceof WebsiteLoginStoreError && error.code === 'website_login_ticket_conflict');
});

test('atomic exchange and completion allow one winner and freeze terminal or ambiguous work', async () => {
  const { store } = fixture(); const input = ticket(); await store.create(input);
  const exchanges = await Promise.all([store.exchange(input.tokenHash), store.exchange(input.tokenHash)]);
  assert.equal(exchanges.filter(Boolean).length, 1);
  const { tokenHash: _hash, ...binding } = input;
  assert.deepEqual(exchanges.find(Boolean), binding);
  const completions = await Promise.all([store.finish(input.tokenHash), store.finish(input.tokenHash)]);
  assert.deepEqual(completions.sort(), [false, true]);
  assert.equal((await store.load(input.tokenHash))?.phase, 'COMPLETING');
  assert.equal(await store.exchange(input.tokenHash), null);
  assert.equal(await store.complete(input.tokenHash, 'SAVED'), true);
  assert.equal(await store.complete(input.tokenHash, 'FAILED'), false);
  assert.equal(await store.finish(input.tokenHash), false);
});

test('expiry is enforced by application and atomic transitions before table TTL deletion', async () => {
  const { store, setNow, rows } = fixture(); const input = ticket(); await store.create(input);
  setNow(input.expiresAt);
  assert.equal(await store.exchange(input.tokenHash), null); assert.equal(await store.load(input.tokenHash), null); assert.equal(await store.finish(input.tokenHash), false);
  assert.equal(rows.size, 1);
});

test('invalid owner or site is rejected and malformed persisted binding cannot be exchanged', async () => {
  const { store, rows, requests } = fixture();
  await assert.rejects(store.create({ ...ticket(), owner: 'clo-personal' }), WebsiteLoginStoreError);
  await assert.rejects(store.create({ ...ticket(), site: 'unknown' as never }), WebsiteLoginStoreError);
  await assert.rejects(store.exchange('raw-token'), WebsiteLoginStoreError);
  assert.equal(requests.length, 0);
  const input = ticket(); await store.create(input);
  rows.get(`WEBSITE_LOGIN#${input.tokenHash}`)!.site = { S: 'wrong-site' };
  await assert.rejects(store.exchange(input.tokenHash), WebsiteLoginStoreError);
});

test('provider request failures do not expose request body or credentials', async () => {
  const store = new WebsiteLoginTicketStore({ fetchImpl: async () => { throw new Error('secret-sensitive-runtime-url'); }, resolveCredentials: async () => ({ accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' }) });
  await assert.rejects(store.create(ticket(Date.now() + 60_000)), (error: unknown) => error instanceof WebsiteLoginStoreError && !error.message.includes('secret-sensitive'));
});

test('profile handoff lease is exclusive, owner-fenced, expires, and is removed only by its owner', async () => {
  const { store, rows, setNow } = fixture(); const profile = 'profile-owned-123';
  assert.equal(await store.acquireProfileLease(profile, 'first-owner', 20_000), true);
  assert.equal(await store.acquireProfileLease(profile, 'second-owner', 30_000), false);
  assert.equal(await store.ownsProfileLease(profile, 'first-owner'), true);
  assert.equal(await store.ownsProfileLease(profile, 'second-owner'), false);
  await store.releaseProfileLease(profile, 'second-owner');
  assert.equal(await store.ownsProfileLease(profile, 'first-owner'), true);
  setNow(20_001);
  assert.equal(await store.ownsProfileLease(profile, 'first-owner'), false);
  assert.equal(await store.acquireProfileLease(profile, 'second-owner', 30_000), true);
  await store.releaseProfileLease(profile, 'first-owner');
  assert.equal(await store.ownsProfileLease(profile, 'second-owner'), true);
  await store.releaseProfileLease(profile, 'second-owner');
  assert.equal(rows.has(`WEBSITE_LOGIN_LEASE#${profile}`), false);
});

test('custom target policy survives durable roundtrip and rejects changed canonical identity', async () => {
  const target = await resolveWebsiteLoginTarget({ url: 'https://example.com/settings/' }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const { store, rows } = fixture(); const input = { ...ticket(), site: 'custom' as const, target };
  await store.create(input);
  assert.deepEqual((await store.load(input.tokenHash))?.target, target);
  rows.get(`WEBSITE_LOGIN#${input.tokenHash}`)!.targetJSON = { S: JSON.stringify({ ...target, origin: 'https://different.example.com' }) };
  assert.equal(await store.load(input.tokenHash), null);
  await assert.rejects(store.exchange(input.tokenHash), WebsiteLoginStoreError);
  await assert.rejects(store.create({ ...ticket(), site: 'custom' }), WebsiteLoginStoreError);
});
