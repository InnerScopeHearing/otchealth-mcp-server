import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamoCloudBrowserSessionStore } from './dynamo-store.js';
import type { CloudBrowserSession } from './contract.js';

const ownedSession: CloudBrowserSession = {
  sessionId: 'session-1', owner: 'developer', profileId: 'developer-trial',
  allowedHosts: ['example.com'], expiresAt: 100_000, actionsUsed: 2,
  providerSessionId: 'provider-1', automationEndpoint: 'wss://example.com/browser',
  ownedTargetIds: ['target-1', 'target-2'], selectedTargetId: 'target-2', effectUnknown: true,
};

test('tab ownership, selection and uncertain effects survive durable round-trip and fenced updates', async t => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  const requests: Record<string, any>[] = [];
  let savedItem: unknown;
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    if (request.Item) savedItem = request.Item;
    return new Response(JSON.stringify(request.ConsistentRead ? { Item: savedItem } : {}));
  });
  await store.saveSession(ownedSession);
  const loaded = await store.loadSession(ownedSession.sessionId);
  assert.deepEqual(loaded?.ownedTargetIds, ['target-1', 'target-2']);
  assert.equal(loaded?.selectedTargetId, 'target-2');
  assert.equal(loaded?.effectUnknown, true);
  await store.saveSessionUnderLock({ ...ownedSession, selectedTargetId: null, ownedTargetIds: [], effectUnknown: false }, 'writer-1');
  const update = requests.at(-1)!;
  assert.equal(update.ConditionExpression, 'lockOwner = :owner');
  assert.match(update.UpdateExpression, /ownedTargetIds = :targets/);
  assert.match(update.UpdateExpression, /selectedTargetId = :selected/);
  assert.match(update.UpdateExpression, /effectUnknown = :uncertain/);
  assert.deepEqual(update.ExpressionAttributeValues[':targets'], { L: [] });
  assert.deepEqual(update.ExpressionAttributeValues[':selected'], { NULL: true });
  assert.deepEqual(update.ExpressionAttributeValues[':uncertain'], { BOOL: false });
});

test('malformed or contradictory durable tab state is rejected without enrolling unknown targets', async t => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  let item: Record<string, unknown> = {};
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.Item) { item = request.Item; return new Response('{}'); }
    return new Response(JSON.stringify({ Item: item }));
  });
  await store.saveSession(ownedSession);
  item.selectedTargetId = { S: 'foreign-target' };
  assert.equal(await store.loadSession(ownedSession.sessionId), null);
  item.selectedTargetId = { S: 'target-2' };
  item.ownedTargetIds = { L: [{ S: 'target-2' }, { N: '7' }] };
  assert.equal(await store.loadSession(ownedSession.sessionId), null);
});

test('profile persistence aliases the DynamoDB reserved owner attribute in its conditional write', async (t) => {
  const prior = { ...process.env };
  t.after(() => { process.env = prior; });
  process.env.AWS_ACCESS_KEY_ID = 'test-access';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';

  let body = '';
  const store = new DynamoCloudBrowserSessionStore('synthetic-browser-state', 'us-east-1', async (_url, init) => {
    body = String(init?.body);
    return new Response('{}', { status: 200 });
  });

  await store.saveProfile({
    profileId: 'cfo-public-trial', owner: 'cfo', allowedHosts: ['example.com'], persistent: false,
  });

  const request = JSON.parse(body) as {
    ConditionExpression?: unknown;
    ExpressionAttributeNames?: unknown;
    ExpressionAttributeValues?: unknown;
  };
  assert.equal(request.ConditionExpression, 'attribute_not_exists(pk) OR #owner = :owner');
  assert.deepEqual(request.ExpressionAttributeNames, { '#owner': 'owner' });
  assert.deepEqual(request.ExpressionAttributeValues, { ':owner': { S: 'cfo' } });
});
