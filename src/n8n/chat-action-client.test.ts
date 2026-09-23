import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CIO_SITE_ID ??= 'test';
process.env.CIO_TRACK_KEY ??= 'test';
process.env.CIO_APP_API_BEARER ??= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('ordinary Chat action paths are stable and separate', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return import('./chat-action-client.js').then(({ CHAT_ACTION_PATHS }) => {
  assert.deepEqual(CHAT_ACTION_PATHS, {
    submit: '/webhook/chat-action-submit',
    status: '/webhook/chat-action-status',
    result: '/webhook/chat-action-result',
  });
  });
});

test('personal legal lane is rejected at every nesting level', () => {
  return import('./chat-action-client.js').then(({ rejectPersonalLegalInput }) => {
  assert.match(rejectPersonalLegalInput({ agent: 'clo-personal' }) ?? '', /not available/);
  assert.match(rejectPersonalLegalInput({ request: { scope: 'clo-personal' } }) ?? '', /not available/);
  assert.match(rejectPersonalLegalInput([{ room: 'clo-personal' }]) ?? '', /not available/);
  assert.equal(rejectPersonalLegalInput({ agent: 'coo', query: 'company workflow status' }), null);
  });
});
