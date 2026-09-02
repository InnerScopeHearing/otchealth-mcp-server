import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskComplete, type TaskCompleteInput } from './task-complete.js';
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

function baseInput(overrides: Partial<TaskCompleteInput> = {}): TaskCompleteInput {
  return { task_id: 't_abc123', artifact_uri: 'gh:pr:InnerScopeHearing/otchealth-mcp-server#266', agent: 'cto', ...overrides };
}

test('a genuine self-completion (agent matches the caller token) is recorded as-is, no claimed_actor', async () => {
  const result = await handleTaskComplete(baseInput({ agent: 'cto' }), fakeCtx('cto'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'cto');
  assert.equal(data.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) claiming to have completed work AS "cto" is recorded under its REAL lane, with the claim preserved for audit', async () => {
  const result = await handleTaskComplete(baseInput({ agent: 'cto' }), fakeCtx('coo'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'coo');
  assert.equal(data.claimed_actor, 'cto');
});
