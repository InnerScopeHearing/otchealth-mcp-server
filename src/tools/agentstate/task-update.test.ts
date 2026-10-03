import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskUpdate, type TaskUpdateDependencies, type TaskUpdateInput } from './task-update.js';
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

function baseInput(overrides: Partial<TaskUpdateInput> = {}): TaskUpdateInput {
  return { task_id: 't_abc123', actor: 'cto', note: 'progress', ...overrides };
}

test('a genuine self-update (actor matches the caller token) is recorded as-is, no claimed_actor', async () => {
  const result = await handleTaskUpdate(baseInput({ actor: 'cto' }), fakeCtx('cto'));
  const data = result.data as { preview: { actor: string }; claimed_actor?: string };
  assert.equal(data.preview.actor, 'cto');
  assert.equal(data.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) claiming actor "cto" on an update note is recorded under its REAL lane', async () => {
  const result = await handleTaskUpdate(baseInput({ actor: 'cto' }), fakeCtx('coo'));
  const data = result.data as { preview: { actor: string }; claimed_actor?: string };
  assert.equal(data.preview.actor, 'coo');
  assert.equal(data.claimed_actor, 'cto');
});

test('owner_agent (the REASSIGNMENT target) is completely untouched by the attribution fix -- reassigning work to a different named agent is this field\'s whole purpose', async () => {
  const result = await handleTaskUpdate(baseInput({ actor: 'coo', owner_agent: 'developer' }), fakeCtx('coo'));
  const data = result.data as { preview: { owner_agent?: string } };
  assert.equal(data.preview.owner_agent, 'developer');
});

test('setting status="done" is rejected before any attribution logic runs (use task_complete instead)', async () => {
  const result = await handleTaskUpdate(baseInput({ actor: 'cto', status: 'done' }), fakeCtx('cto'));
  const data = result.data as { updated: boolean; reason?: string };
  assert.equal(data.updated, false);
  assert.match(data.reason ?? '', /task_complete/);
});

test('a stale lease returned by the ledger is surfaced as fenced and forwards the expected version', async () => {
  const taskId = 't_synthetic_update_fence';
  const expectedVersion = 1;
  const ledgerReason = 'synthetic stale lease_version';
  const calls: Parameters<TaskUpdateDependencies['updateTask']>[] = [];
  const deps: TaskUpdateDependencies = {
    isConfigured: () => true,
    taskVisibleToCaller: () => true,
    updateTask: async (...args) => {
      calls.push(args);
      return { fenced: true, reason: ledgerReason };
    },
  };

  const result = await handleTaskUpdate(
    baseInput({ task_id: taskId, actor: 'cto', expected_lease_version: expectedVersion }),
    fakeCtx('cto', false),
    deps,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], taskId);
  assert.equal(calls[0][2], 'cto');
  assert.equal(calls[0][4], expectedVersion);
  assert.deepEqual(result.data, { updated: false, fenced: true, reason: ledgerReason });
});
