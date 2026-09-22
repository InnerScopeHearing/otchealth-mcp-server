import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamoCloudBrowserSessionStore } from './dynamo-store.js';

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
