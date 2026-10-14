import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  IntercomLoginStoreError,
  IntercomLoginTicketStore,
  type CreateIntercomLoginTicket,
} from './intercom-login-store.js';

type Attr = { S?: string; N?: string };
type Item = Record<string, Attr>;
type Request = Record<string, any>;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = { accessKeyId: 'test-access', secretAccessKey: 'test-secret' };

function ticket(token: string, expiresAt = 90_000): CreateIntercomLoginTicket {
  return {
    tokenHash: hash(token),
    ownerSubjectHash: hash('coo-subject'),
    profileId: 'coo-intercom-persistent',
    sessionId: 'session-123',
    expectedWorkspaceId: 'workspace-456',
    expiresAt,
  };
}

function memoryDynamo(now: () => number) {
  const rows = new Map<string, Item>();
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    const pk = request.Key?.pk?.S ?? request.Item?.pk?.S;
    if (!pk) return new Response('{}', { status: 400 });
    if (request.PutItem) return new Response('{}');
    if ('Item' in request) {
      if (rows.has(pk)) return new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 });
      rows.set(pk, structuredClone(request.Item));
      return new Response('{}');
    }
    if (request.ConsistentRead) return new Response(JSON.stringify(rows.has(pk) ? { Item: rows.get(pk) } : {}));
    if (request.UpdateExpression) {
      const row = rows.get(pk);
      const values = request.ExpressionAttributeValues as Record<string, Attr>;
      const phase = row?.phase?.S;
      const currentExpiry = Number(row?.expiresAt?.N);
      const condition = String(request.ConditionExpression);
      const valid = condition.includes('#phase = :new')
        ? phase === 'NEW' && currentExpiry > now()
        : condition.includes('#phase = :exchanged')
          ? phase === 'EXCHANGED' && currentExpiry > now()
          : condition.includes('#phase = :completing') && phase === 'COMPLETING';
      if (!row || !valid) return new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 });
      row.phase = structuredClone(values[':outcome'] ?? values[':completing'] ?? values[':exchanged']);
      if (request.ReturnValues === 'ALL_NEW') return new Response(JSON.stringify({ Attributes: row }));
      return new Response('{}');
    }
    return new Response('{}');
  };
  return { rows, requests, fetchImpl };
}

function makeStore(now: () => number, fetchImpl: typeof fetch) {
  return new IntercomLoginTicketStore({
    tableName: 'synthetic-browser-state',
    region: 'us-east-1',
    fetchImpl,
    resolveCredentials: async () => credentials,
    now,
  });
}

test('ticket creation uses a hashed key, explicit TTL, and create-only condition', async () => {
  let now = 10_000;
  const db = memoryDynamo(() => now);
  const store = makeStore(() => now, db.fetchImpl);
  const input = ticket('opaque-one-time-token', 80_001);
  await store.create(input);

  const item = db.rows.get(`INTERCOM_LOGIN#${input.tokenHash}`)!;
  assert.equal(item.phase?.S, 'NEW');
  assert.equal(item.ownerSubjectHash?.S, input.ownerSubjectHash);
  assert.equal(item.profileId?.S, input.profileId);
  assert.equal(item.sessionId?.S, input.sessionId);
  assert.equal(item.expectedWorkspaceId?.S, input.expectedWorkspaceId);
  assert.equal(item.expiresAt?.N, '80001');
  assert.equal(item.expiresAtEpoch?.N, '81');
  assert.equal(JSON.stringify(item).includes('opaque-one-time-token'), false);
  assert.equal(db.requests[0].ConditionExpression, 'attribute_not_exists(pk)');

  await assert.rejects(store.create(input), (error: unknown) => error instanceof IntercomLoginStoreError && error.code === 'intercom_login_ticket_conflict');
  now = 80_001;
});

test('exchange, finish, and completion are atomic one-way transitions', async () => {
  let now = 1_000;
  const db = memoryDynamo(() => now);
  const store = makeStore(() => now, db.fetchImpl);
  const input = ticket('single-use-token', 20_000);
  await store.create(input);

  const [first, replay] = await Promise.all([store.exchange(input.tokenHash), store.exchange(input.tokenHash)]);
  assert.equal(Number(first !== null) + Number(replay !== null), 1, 'only one exchange wins');
  assert.deepEqual(first ?? replay, {
    ownerSubjectHash: input.ownerSubjectHash,
    profileId: input.profileId,
    sessionId: input.sessionId,
    expectedWorkspaceId: input.expectedWorkspaceId,
    expiresAt: input.expiresAt,
  });
  assert.equal(JSON.stringify(first ?? replay).includes(input.tokenHash), false);
  assert.equal(await store.exchange(input.tokenHash), null, 'an exchanged ticket cannot be exchanged again');

  assert.equal(await store.finish(input.tokenHash), true);
  assert.equal(await store.finish(input.tokenHash), false, 'COMPLETING cannot be claimed again');
  assert.equal(await store.complete(input.tokenHash, 'SAVED'), true);
  assert.equal(await store.complete(input.tokenHash, 'FAILED'), false, 'terminal state cannot be changed');
  assert.equal((await store.load(input.tokenHash))?.phase, 'SAVED');

  const failedInput = ticket('single-use-token-failure', 20_000);
  await store.create(failedInput);
  assert.ok(await store.exchange(failedInput.tokenHash));
  assert.equal(await store.finish(failedInput.tokenHash), true);
  assert.equal(await store.complete(failedInput.tokenHash, 'FAILED'), true);
  assert.equal((await store.load(failedInput.tokenHash))?.phase, 'FAILED');

  assert.ok(db.requests.every((request) => request.TableName === 'synthetic-browser-state'));
  now = 20_000;
  assert.equal(await store.load(input.tokenHash), null, 'expired ticket is unusable even before DynamoDB TTL cleanup');
});

test('expired tickets cannot exchange or claim completion', async () => {
  let now = 5_000;
  const db = memoryDynamo(() => now);
  const store = makeStore(() => now, db.fetchImpl);
  const input = ticket('expired-token', 6_000);
  await store.create(input);
  now = 6_000;
  assert.equal(await store.exchange(input.tokenHash), null);
  assert.equal(await store.finish(input.tokenHash), false);
  assert.equal(await store.load(input.tokenHash), null);
});

test('invalid hashes and IDs are rejected before any DynamoDB request', async () => {
  const db = memoryDynamo(() => 1_000);
  const store = makeStore(() => 1_000, db.fetchImpl);
  await assert.rejects(store.exchange('not-a-sha256-hash'), IntercomLoginStoreError);
  await assert.rejects(store.create({ ...ticket('valid-token'), profileId: 'https://provider.example/path' }), IntercomLoginStoreError);
  assert.equal(db.requests.length, 0);
});

test('DynamoDB failures make one bounded request and expose only a generic error', async () => {
  let calls = 0;
  let hadAbortSignal = false;
  const store = new IntercomLoginTicketStore({
    tableName: 'synthetic-browser-state',
    region: 'us-east-1',
    resolveCredentials: async () => credentials,
    fetchImpl: async (_url, init) => {
      calls += 1;
      hadAbortSignal = init?.signal instanceof AbortSignal;
      throw new Error('sensitive-token-and-request-url-must-not-escape');
    },
    now: () => 1_000,
  });
  await assert.rejects(store.create(ticket('failure-token')), (error: unknown) => {
    assert.ok(error instanceof IntercomLoginStoreError);
    assert.equal(error.message, 'Intercom login setup could not be completed safely.');
    assert.equal(error.message.includes('sensitive-token'), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(hadAbortSignal, true);
});
