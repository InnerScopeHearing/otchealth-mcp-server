import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CIO_SITE_ID ??= 'test'; process.env.CIO_TRACK_KEY ??= 'test'; process.env.CIO_APP_API_BEARER ??= 'test'; process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32); process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('executor forwards company lane context to checkpoint adapter', async () => {
  const { createChatActionExecutor } = await import('./chat-action-executor.js');
  let seen: any;
  const executor = createChatActionExecutor(async (request, context) => { seen = { request, context }; return { checkpoint: true }; });
  const out = await executor.checkpoint({ agent: 'coo', memories: [] }, { callerHash: 'hash-123456', callerAgent: 'coo', correlationId: 'corr-123', });
  assert.deepEqual(out, { checkpoint: true }); assert.equal(seen.context.callerAgent, 'coo'); assert.equal(seen.context.dryRun, false); assert.equal(seen.context.correlationId, 'corr-123');
});

test('executor fails closed for unknown and personal lanes', async () => {
  const { createChatActionExecutor } = await import('./chat-action-executor.js');
  const executor = createChatActionExecutor(async () => ({}));
  await assert.rejects(() => executor.checkpoint({}, { callerHash: 'hash-123456', callerAgent: 'unknown', correlationId: 'corr-123' }), /caller_lane_not_allowed/);
  await assert.rejects(() => executor.checkpoint({ agent: 'clo-personal' }, { callerHash: 'hash-123456', callerAgent: 'clo-personal', correlationId: 'corr-123' }), /caller_lane_not_allowed/);
});
