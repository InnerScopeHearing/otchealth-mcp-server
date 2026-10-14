import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AGENT_INBOX_STORAGE_ACCOUNT ||= 'receiptfixture';
process.env.AGENT_INBOX_STORAGE_KEY ||= Buffer.from('test-key').toString('base64');

const { enqueue } = await import('./queue-azure.js');
const originalFetch = globalThis.fetch;
let postBody = '';
let postResponse = '<QueueMessagesList><QueueMessage><MessageId>azure-native-id-17</MessageId></QueueMessage></QueueMessagesList>';
let postStatus = 201;

before(() => {
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') return new Response('', { status: 201 });
    postBody = String(init?.body ?? '');
    return new Response(postResponse, { status: postStatus });
  };
});

after(() => { globalThis.fetch = originalFetch; });

test('Azure enqueue returns the native MessageId from a successful persisted response', async () => {
  assert.equal(await enqueue('developer', { to: 'developer', from: 'cto', subject: 'handoff', body: 'body', ts: '2026-10-14T00:00:00.000Z' }), 'azure-native-id-17');
  assert.match(postBody, /<QueueMessage>/);
});

test('Azure enqueue returns no fabricated ID when response omits it and throws on failed enqueue', async () => {
  postResponse = '<QueueMessagesList />';
  assert.equal(await enqueue('developer', { to: 'developer', from: 'cto', subject: 'handoff', body: 'body', ts: '2026-10-14T00:00:00.000Z' }), undefined);

  postStatus = 503;
  await assert.rejects(
    () => enqueue('developer', { to: 'developer', from: 'cto', subject: 'handoff', body: 'body', ts: '2026-10-14T00:00:00.000Z' }),
    /enqueue inbox-developer -> 503/,
  );
});
