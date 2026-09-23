import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CIO_SITE_ID ??= 'test'; process.env.CIO_TRACK_KEY ??= 'test'; process.env.CIO_APP_API_BEARER ??= 'test'; process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32); process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('worker claims, dispatches, and persists terminal success', async () => {
  const { runQueuedChatActionJob } = await import('./chat-action-worker.js');
  const job: any = { id: 'caj_' + 'a'.repeat(64), type: 'chat_action_job', caller_hash: 'caller-a-123456', action: 'brain_search', request: { query: 'synthetic' }, status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), idempotency_key_hash: 'x' };
  const writes: any[] = []; let dispatched = false;
  const deps: any = { readDoc: async () => job, replaceDoc: async (_c: string, _p: string, _id: string, doc: any) => { writes.push(doc); Object.assign(job, doc); }, queryDocs: async () => [job], execute: { brainSearch: async (request: any, caller: string) => { dispatched = request.query === 'synthetic' && caller === job.caller_hash; return { count: 0 }; }, checkpoint: async () => ({}) } };
  const out = await runQueuedChatActionJob(job.id, job.caller_hash, deps);
  assert.equal(out.status, 'succeeded'); assert.equal(dispatched, true); assert.deepEqual(writes.map(w => w.status), ['running', 'succeeded']);
});

test('worker rejects protected personal content before claiming', async () => {
  const { runQueuedChatActionJob } = await import('./chat-action-worker.js');
  const job: any = { id: 'caj_' + 'b'.repeat(64), type: 'chat_action_job', caller_hash: 'caller-a-123456', action: 'checkpoint', request: { agent: 'clo-personal' }, status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  let writes = 0;
  await assert.rejects(() => runQueuedChatActionJob(job.id, job.caller_hash, { readDoc: async () => job, replaceDoc: async () => { writes += 1; }, queryDocs: async () => [job], execute: { brainSearch: async () => ({}), checkpoint: async () => ({}) } }), /clo-personal/);
  assert.equal(writes, 0);
});
