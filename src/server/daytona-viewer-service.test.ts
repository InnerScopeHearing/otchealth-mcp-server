import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { URL as URLConstructor } from 'node:url';
import test from 'node:test';
import { DaytonaViewerHandoffService, DynamoDaytonaViewerTicketStore, type DaytonaViewerTicket, type DaytonaViewerTicketStore, type DaytonaViewerMissionBoundary } from './daytona-viewer-service.js';

const NOW = 1_900_000_000_000;
const PRINCIPAL = 'a'.repeat(64);
const SESSION = randomUUID();
const HANDLE = randomUUID();
const URL = 'https://6080-signed.proxy.daytona.works/vnc.html';
function fixture() {
  let now = NOW;
  const rows = new Map<string, DaytonaViewerTicket>();
  const leases = new Map<string, string>();
  const calls: string[] = [];
  let activeHandle: string | undefined;
  const store: DaytonaViewerTicketStore = {
    create: async (hash, row) => { if (rows.has(hash)) return false; rows.set(hash, structuredClone(row)); return true; },
    load: async hash => structuredClone(rows.get(hash) ?? null),
    transition: async (hash, phase, next) => { const old = rows.get(hash); if (!old || old.phase !== phase || old.version + 1 !== next.version) return false; rows.set(hash, structuredClone(next)); return true; },
    acquireMissionLease: async (id, hash) => { if (leases.has(id)) return false; leases.set(id, hash); return true; },
    ownsMissionLease: async (id, hash) => leases.get(id) === hash,
    releaseMissionLease: async (id, hash) => { if (leases.get(id) === hash) leases.delete(id); },
  };
  const missions: DaytonaViewerMissionBoundary = {
    loadSession: async id => ({ sessionId: id, owner: 'cto', ownerSubjectHash: PRINCIPAL, expiresAt: NOW + 600_000, phase: 'ACTIVE', effectUnknown: false, ...(activeHandle ? { viewerGrantHandle: activeHandle } : {}) }),
    getViewerGrant: async (owner, id, principal, seconds) => { assert.equal(owner, 'cto'); assert.equal(id, SESSION); assert.equal(principal, PRINCIPAL); calls.push(`mint:${seconds}`); activeHandle = HANDLE; return { url: URL, expiresAt: NOW + 90_000, grantHandle: HANDLE }; },
    resumeViewerGrant: async (_owner, _id, _principal, handle) => { assert.equal(handle, HANDLE); calls.push('resume'); return { url: URL, expiresAt: NOW + 90_000, grantHandle: HANDLE }; },
    completeHumanInput: async () => { calls.push('complete'); return { status: 'saved', human_input_revoked: true }; },
    stop: async () => { calls.push('stop'); },
  };
  return { rows, leases, store, missions, calls, advance: (ms: number) => { now += ms; }, service: new DaytonaViewerHandoffService(store, missions, () => now) };
}

test('Daytona bearer handoff persists only SHA lookup and owned mission binding; single exchange/resume preserves same grant and original expiry', async () => {
  const f = fixture();
  const start = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(start.login_url).hash.slice('#token='.length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.expires_at, NOW + 120_000);
  assert.equal(JSON.stringify([...f.rows]).includes(token), false);
  const view = await f.service.exchange(token);
  assert.deepEqual(view, { signed_url: URL, expires_at: NOW + 90_000 });
  await assert.rejects(f.service.exchange(token));
  f.advance(5_000);
  assert.deepEqual(await f.service.resume(token), view);
  assert.deepEqual(f.calls, ['mint:120', 'resume']);
  assert.equal(JSON.stringify([...f.rows]).includes(URL), false);
  assert.equal([...f.rows.values()][0]!.expiresAt, NOW + 120_000);
  await f.service.complete(token);
  assert.deepEqual(f.calls, ['mint:120', 'resume', 'complete']);
  assert.equal(f.leases.size, 0);
  await assert.rejects(f.service.complete(token));
});

test('Daytona bearer adapter rejects foreign/expired missions before minting and keeps one durable mission handoff lease', async () => {
  const f = fixture();
  await assert.rejects(f.service.issue('cro', SESSION, PRINCIPAL, 60));
  await assert.rejects(f.service.issue('cto', SESSION, 'b'.repeat(64), 60));
  await assert.rejects(f.service.issue('cto', SESSION, PRINCIPAL, 601));
  const first = await f.service.issue('cto', SESSION, PRINCIPAL, 60);
  await assert.rejects(f.service.issue('cto', SESSION, PRINCIPAL, 60));
  f.advance(60_001);
  await assert.rejects(f.service.exchange(new URLConstructor(first.login_url).hash.slice(7)));
  assert.deepEqual(f.calls, []);
});

test('Daytona mint ambiguity and lost durable grant receipt retain permanent effect fence and lease without retries', async () => {
  for (const mode of ['provider', 'store']) {
    const f = fixture();
    const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
    const token = new URLConstructor(started.login_url).hash.slice(7);
    if (mode === 'provider') f.missions.getViewerGrant = async () => { f.calls.push('unknown'); throw new Error('raw-secret'); };
    else { const save = f.store.transition; f.store.transition = async (hash, phase, next) => { if (phase === 'ISSUING') throw new Error('storage-unknown'); return save(hash, phase, next); }; }
    await assert.rejects(f.service.exchange(token));
    assert.equal([...f.rows.values()][0]!.phase, 'ISSUING');
    assert.equal(f.leases.size, 1);
    const count = f.calls.length;
    await assert.rejects(f.service.exchange(token));
    await assert.rejects(f.service.resume(token));
    await assert.rejects(f.service.complete(token));
    assert.equal(f.calls.length, count);
  }
});

test('Daytona resume/Done serialize on durable phase and unknown revocation never releases lease or retries', async () => {
  const f = fixture();
  const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  await f.service.exchange(token);
  let finish: ((value: { url: string; expiresAt: number; grantHandle: string }) => void) | undefined;
  f.missions.resumeViewerGrant = async () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.resume(token);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await assert.rejects(f.service.complete(token));
  assert.equal(f.calls.includes('complete'), false);
  finish!({ url: URL, expiresAt: NOW + 90_000, grantHandle: HANDLE });
  await pending;
  f.missions.completeHumanInput = async () => { f.calls.push('unknown-revoke'); throw new Error('uncertain'); };
  await assert.rejects(f.service.complete(token));
  assert.equal([...f.rows.values()][0]!.phase, 'COMPLETING');
  assert.equal(f.leases.size, 1);
  await assert.rejects(f.service.resume(token));
  await assert.rejects(f.service.complete(token));
  assert.equal(f.calls.filter(call => call === 'unknown-revoke').length, 1);
});

test('Daytona cancellation requires confirmed owned mission stop before lease release', async () => {
  const f = fixture();
  const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  await f.service.exchange(token);
  assert.deepEqual(await f.service.expire(token), { status: 'expired', human_input_revoked: true });
  assert.deepEqual(f.calls, ['mint:120', 'stop']);
  assert.equal(f.leases.size, 0);
});

test('Daytona Dynamo ticket wire uses exact phase/version and owner fences; metadata never stores bearer URLs', async () => {
  const requests: Record<string, unknown>[] = [];
  const store = new DynamoDaytonaViewerTicketStore({ now: () => NOW, resolveCredentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }), fetchImpl: async (_input, init) => { requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response('{}', { status: 200 }); } });
  const hash = 'b'.repeat(64);
  const row: DaytonaViewerTicket = { owner: 'cto', principalHash: PRINCIPAL, sessionId: SESSION, expiresAt: NOW + 120000, phase: 'NEW', version: 0 };
  await store.create(hash, row);
  await store.transition(hash, 'NEW', { ...row, phase: 'ISSUING', version: 1 });
  await store.acquireMissionLease(SESSION, hash);
  await store.releaseMissionLease(SESSION, hash);
  assert.equal(requests[0]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(requests[1]!.ConditionExpression, '#phase = :old AND #version = :oldVersion');
  assert.deepEqual((requests[1]!.ExpressionAttributeValues as Record<string, unknown>)[':oldVersion'], { N: '0' });
  assert.equal(requests[2]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(requests[3]!.ConditionExpression, '#owner = :owner');
  assert.equal(JSON.stringify(requests).includes(URL), false);
});

test('Daytona Dynamo codec rejects missing ownership and unpaired grant metadata', async () => {
  let payload: Record<string, unknown> = { principalHash: PRINCIPAL, sessionId: SESSION, expiresAt: NOW + 100000, phase: 'NEW', version: 0 };
  const hash = 'b'.repeat(64);
  const store = new DynamoDaytonaViewerTicketStore({ resolveCredentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }), fetchImpl: async () => new Response(JSON.stringify({ Item: { pk: { S: `DAYTONA_VIEWER#TICKET#${hash}` }, payload: { S: JSON.stringify(payload) }, phase: { S: 'NEW' }, version: { N: '0' } } })) });
  await assert.rejects(store.load(hash));
  payload = { ...payload, owner: 'cto', grantExpiresAt: NOW + 90000 };
  await assert.rejects(store.load(hash));
});
