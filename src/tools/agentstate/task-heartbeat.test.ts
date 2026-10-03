import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskHeartbeat, type TaskHeartbeatDependencies, type TaskHeartbeatInput } from './task-heartbeat.js';
import type { ToolContext } from '../registry.js';

// Handler-level tests through the actual exported entry point. The attribution regressions below
// use dry_run previews; the injected-ledger regression exercises lease fencing without live I/O.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32),
    PG_HOST: 'localhost',
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

function fakeCtx(callerAgent: string, dryRun = true): ToolContext {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

function baseInput(overrides: Partial<TaskHeartbeatInput> = {}): TaskHeartbeatInput {
  return { task_id: 't_abc123', agent: 'cto', ...overrides };
}

test('a genuine self-heartbeat (agent matches the caller token) is recorded as-is, no claimed_actor', async () => {
  const result = await handleTaskHeartbeat(baseInput({ agent: 'cto' }), fakeCtx('cto'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'cto');
  assert.equal(data.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) cannot extend a lease AS "cto" -- the identity checked against the current owner_agent is bound to the real token, not the caller-supplied claim', async () => {
  const result = await handleTaskHeartbeat(baseInput({ agent: 'cto' }), fakeCtx('coo'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'coo', 'the identity actually checked/extended must be the token-bound lane');
  assert.equal(data.claimed_actor, 'cto');
});

test('a stale lease returned by the ledger is surfaced as fenced and forwards the expected version', async () => {
  const taskId = 't_synthetic_heartbeat_fence';
  const expectedVersion = 1;
  const ledgerReason = 'synthetic stale lease_version';
  const calls: Parameters<TaskHeartbeatDependencies['heartbeatTask']>[] = [];
  const deps: TaskHeartbeatDependencies = {
    isConfigured: () => true,
    taskVisibleToCaller: () => true,
    heartbeatTask: async (...args) => {
      calls.push(args);
      return { fenced: true, reason: ledgerReason };
    },
  };

  const result = await handleTaskHeartbeat(
    baseInput({ task_id: taskId, agent: 'cto', expected_lease_version: expectedVersion }),
    fakeCtx('cto', false),
    deps,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], taskId);
  assert.equal(calls[0][1], 'cto');
  assert.equal(calls[0][3], expectedVersion);
  assert.deepEqual(result.data, { extended: false, fenced: true, reason: ledgerReason });
});
