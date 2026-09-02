import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskUpdate, type TaskUpdateInput } from './task-update.js';
import type { ToolContext } from '../registry.js';

// Handler-level tests through the ACTUAL registered entry point. See task-create.test.ts's header
// comment for why these are dry_run-only and why that is still sufficient to prove the fix.
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
