import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentDispatch, type AgentDispatchQueue } from './agent-dispatch.js';
import type { ToolContext } from '../registry.js';

const input = { to_agent: 'developer', subject: 'handoff', body: 'Please inspect the patch.', from_agent: 'cto' };
const ctx = (dryRun: boolean): ToolContext => ({
  correlationId: 'call-correlation-id',
  callerHash: 'caller-hash',
  dryRun,
  acknowledgeWarning: false,
  callerAgent: 'cto',
});

test('agent_dispatch returns and audits the exact persisted queue message ID', async () => {
  const persistedId = '8d508982-18f9-4d50-88d0-ae89e48728c4';
  let enqueued = 0;
  const queue: AgentDispatchQueue = {
    isConfigured: () => true,
    enqueue: async () => { enqueued++; return persistedId; },
  };

  const result = await handleAgentDispatch(input, ctx(false), queue);
  assert.equal(enqueued, 1);
  assert.deepEqual(result.data, { dispatched: true, to: 'developer', message_id: persistedId });
  assert.equal((result.audit?.after as { message_id: string }).message_id, persistedId);
  assert.notEqual(persistedId, ctx(false).correlationId);
});

test('agent_dispatch keeps unknown, dry-run, and failed enqueue outcomes receipt-free', async () => {
  let calls = 0;
  const unknownQueue: AgentDispatchQueue = {
    isConfigured: () => true,
    enqueue: async () => { calls++; return undefined; },
  };
  const unknown = await handleAgentDispatch(input, ctx(false), unknownQueue);
  assert.deepEqual(unknown.data, { dispatched: true, to: 'developer' });

  const dryRun = await handleAgentDispatch(input, ctx(true), unknownQueue);
  assert.equal((dryRun.data as { dispatched: boolean }).dispatched, false);
  assert.equal('message_id' in (dryRun.data as object), false);
  assert.equal(calls, 1, 'dry_run must not enqueue');

  const unconfigured = await handleAgentDispatch(input, ctx(false), { ...unknownQueue, isConfigured: () => false });
  assert.equal((unconfigured.data as { dispatched: boolean }).dispatched, false);
  assert.equal('message_id' in (unconfigured.data as object), false);

  const failedQueue: AgentDispatchQueue = {
    isConfigured: () => true,
    enqueue: async () => { throw new Error('queue unavailable'); },
  };
  await assert.rejects(() => handleAgentDispatch(input, ctx(false), failedQueue), /queue unavailable/);
});
