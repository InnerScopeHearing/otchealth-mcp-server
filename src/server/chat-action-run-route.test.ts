import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CIO_SITE_ID ??= 'test'; process.env.CIO_TRACK_KEY ??= 'test'; process.env.CIO_APP_API_BEARER ??= 'test'; process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32); process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('run route module exports a service-only registration function', async () => {
  const { registerChatActionRunRoute } = await import('./chat-action-run-route.js');
  assert.equal(typeof registerChatActionRunRoute, 'function');
});
