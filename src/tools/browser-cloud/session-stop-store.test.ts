import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudBrowserSession } from './contract.js';
import { DynamoCloudBrowserSessionStore } from './dynamo-store.js';

const session: CloudBrowserSession = {
  sessionId: 'session-1', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), profileId: 'web-cto-linkedin-test',
  allowedHosts: ['www.linkedin.com'], expiresAt: 100_000, actionsUsed: 0,
  providerSessionId: 'provider-session-1', providerBrowserId: 'aws.browser.v1', automationEndpoint: 'wss://provider.example/automation',
  loginLeaseOwner: '1c6c89e8-aa61-42a2-822b-44d1aa928ccf', providerStopToken: '0fa7b381-daf2-4c90-bbe4-ff0b1353c666',
  providerStopped: true, sensitiveOutputSuppressed: true,
};

function credentials(t: { after(callback: () => void): void }) {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
}

test('trusted login lease and stop receipt survive durable session round-trip and fenced updates', async t => {
  credentials(t);
  const requests: Record<string, any>[] = [];
  let item: Record<string, any> | undefined;
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    if (request.Item) item = request.Item;
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: item } : {}));
  });
  await store.saveSession(session);
  const loaded = await store.loadSession(session.sessionId);
  assert.equal(loaded?.loginLeaseOwner, session.loginLeaseOwner);
  assert.equal(loaded?.providerStopToken, session.providerStopToken);
  assert.equal(loaded?.providerStopped, true);
  await store.saveSessionUnderLock(session, 'cleanup-lock');
  const update = requests.at(-1)!;
  assert.equal(update.ConditionExpression, 'lockOwner = :owner');
  assert.match(update.UpdateExpression, /loginLeaseOwner = :loginLeaseOwner/);
  assert.match(update.UpdateExpression, /providerStopToken = :providerStopToken/);
  assert.match(update.UpdateExpression, /providerStopped = :providerStopped/);
  assert.deepEqual(update.ExpressionAttributeValues[':loginLeaseOwner'], { S: session.loginLeaseOwner });
  assert.deepEqual(update.ExpressionAttributeValues[':providerStopToken'], { S: session.providerStopToken });
  assert.deepEqual(update.ExpressionAttributeValues[':providerStopped'], { BOOL: true });
});

test('trusted login session TTL retains cleanup metadata through the lease grace without changing actual expiry', async t => {
  credentials(t);
  const requests: Record<string, any>[] = [];
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return new Response('{}');
  });
  await store.saveSession(session);
  assert.deepEqual(requests.at(-1)!.Item.expiresAt, { N: '100000' });
  assert.deepEqual(requests.at(-1)!.Item.expiresAtEpoch, { N: '130' });
  await store.saveSessionUnderLock(session, 'cleanup-lock');
  assert.deepEqual(requests.at(-1)!.ExpressionAttributeValues[':expires'], { N: '100000' });
  assert.deepEqual(requests.at(-1)!.ExpressionAttributeValues[':ttl'], { N: '130' });
  await store.saveSession({ ...session, loginLeaseOwner: undefined, providerStopToken: undefined, providerStopped: undefined });
  assert.deepEqual(requests.at(-1)!.Item.expiresAtEpoch, { N: '100' });
});

test('stopped login lease cleanup verifies the exact locked durable session and conditionally deletes only its lease owner', async t => {
  credentials(t);
  const requests: Array<{ target: string; body: Record<string, any> }> = [];
  let item: Record<string, any> | undefined;
  let conflict = false;
  let unavailable = false;
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const target = (init?.headers as Record<string, string>)['x-amz-target']!;
    requests.push({ target, body });
    if (body.Item) item = { ...body.Item, lockOwner: { S: 'cleanup-lock' } };
    if (target.endsWith('.GetItem')) return new Response(JSON.stringify({ Item: item }));
    if (target.endsWith('.DeleteItem') && conflict) return new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 });
    if (target.endsWith('.DeleteItem') && unavailable) return new Response('{}', { status: 500 });
    return new Response('{}');
  });
  await store.saveSession(session);
  await store.releaseStoppedLoginLease(session, 'cleanup-lock');
  const read = requests.at(-2)!.body;
  assert.deepEqual(read.Key, { pk: { S: 'SESSION#session-1' } });
  assert.equal(read.ConsistentRead, true);
  const release = requests.at(-1)!.body;
  assert.deepEqual(release.Key, { pk: { S: `WEBSITE_LOGIN_LEASE#${session.profileId}` } });
  assert.equal(release.ConditionExpression, 'lockOwner = :leaseOwner');
  assert.deepEqual(release.ExpressionAttributeValues, { ':leaseOwner': { S: session.loginLeaseOwner } });
  conflict = true;
  await store.releaseStoppedLoginLease(session, 'cleanup-lock'); // Missing/replaced old lease is already safe.
  conflict = false; unavailable = true;
  await assert.rejects(store.releaseStoppedLoginLease(session, 'cleanup-lock'), { code: 'session_store_failed' });
});

test('foreign or unconfirmed durable session metadata cannot release any login lease', async t => {
  credentials(t);
  let item: Record<string, any> = {};
  let deletes = 0;
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) item = { ...request.Item, lockOwner: { S: 'cleanup-lock' } };
    if ((init?.headers as Record<string, string>)['x-amz-target']!.endsWith('.DeleteItem')) deletes++;
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: item } : {}));
  });
  for (const [field, value] of [
    ['owner', { S: 'coo' }], ['ownerSubjectHash', { S: 'b'.repeat(64) }], ['profileId', { S: 'foreign-profile' }],
    ['providerSessionId', { S: 'foreign-provider-session' }], ['providerBrowserId', { S: 'foreign-browser' }],
    ['loginLeaseOwner', { S: 'new-lease-owner' }], ['providerStopToken', { S: '5e2c620b-c1b3-4b6c-aa43-10e4960e21d8' }],
    ['providerStopped', { BOOL: false }], ['lockOwner', { S: 'foreign-lock' }],
  ] as const) {
    await store.saveSession(session);
    item[field] = value;
    await assert.rejects(store.releaseStoppedLoginLease(session, 'cleanup-lock'), { code: 'login_lease_cleanup_invalid' });
  }
  assert.equal(deletes, 0);
});

test('malformed or unbound lifecycle metadata fails closed on writes and durable reads', async t => {
  credentials(t);
  let item: Record<string, any> = {};
  let writes = 0;
  const store = new DynamoCloudBrowserSessionStore('synthetic-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) { writes++; item = request.Item; }
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: item } : {}));
  });
  for (const invalid of [
    { ...session, loginLeaseOwner: '' }, { ...session, ownerSubjectHash: undefined },
    { ...session, providerStopToken: 'not-a-uuid' }, { ...session, loginLeaseOwner: undefined },
  ]) await assert.rejects(store.saveSession(invalid), { code: 'session_state_invalid' });
  assert.equal(writes, 0);
  await store.saveSession(session);
  item.providerStopToken = { S: 'malformed' };
  assert.equal(await store.loadSession(session.sessionId), null);
});
