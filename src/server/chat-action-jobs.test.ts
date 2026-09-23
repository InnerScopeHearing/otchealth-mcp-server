import assert from 'node:assert/strict';
import test from 'node:test';
process.env.CIO_SITE_ID ??= 'test'; process.env.CIO_TRACK_KEY ??= 'test'; process.env.CIO_APP_API_BEARER ??= 'test'; process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32); process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('chat action jobs are caller-bound and idempotent', async () => {
  const { createChatActionJob } = await import('./chat-action-jobs.js');
  const docs = new Map<string, any>(); const deps = { configured: () => true, readDoc: async (_c: string, _p: string, id: string) => docs.get(id) ?? null, createDoc: async (_c: string, _p: string, doc: any) => { docs.set(doc.id, doc); return doc; } };
  const input = { action: 'brain_search' as const, request: { query: 'synthetic company status' }, idempotency_key: 'chat-job-test-01', correlation_id: 'corr-1', caller_hash: 'caller-a-123456' };
  const first = await createChatActionJob(input, deps); const replay = await createChatActionJob(input, deps);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.job.id, replay.job.id); assert.equal(first.job.status, 'queued');
});

test('personal legal actions are rejected before persistence', async () => {
  const { createChatActionJob } = await import('./chat-action-jobs.js');
  const deps = { configured: () => true, readDoc: async () => null, createDoc: async () => { throw new Error('must not write'); } };
  await assert.rejects(() => createChatActionJob({ action: 'checkpoint', request: { agent: 'clo-personal' }, idempotency_key: 'chat-job-test-02', correlation_id: 'corr-2', caller_hash: 'caller-a-123456' }, deps), /clo-personal/);
});
