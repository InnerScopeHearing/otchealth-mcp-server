import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskClaim, type TaskClaimInput } from './task-claim.js';
import type { ToolContext } from '../registry.js';

// Handler-level tests through the ACTUAL registered entry point. See task-create.test.ts's header
// comment for why these are dry_run-only (loadEnv() memoization rules out toggling isConfigured()
// mid-suite) and why that is still sufficient to prove the attribution fix.
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

function baseInput(overrides: Partial<TaskClaimInput> = {}): TaskClaimInput {
  return { task_id: 't_abc123', agent: 'cto', ...overrides };
}

test('a genuine self-claim (agent matches the caller token) is recorded as-is, no claimed_actor', async () => {
  const result = await handleTaskClaim(baseInput({ agent: 'cto' }), fakeCtx('cto'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'cto');
  assert.equal(data.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) trying to claim a lease AS "cto" is bound to its REAL lane -- the lease holder can never be spoofed, not just mislabeled', async () => {
  const result = await handleTaskClaim(baseInput({ agent: 'cto' }), fakeCtx('coo'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'coo', 'the lease holder that would actually be written must be the token-bound lane');
  assert.equal(data.claimed_actor, 'cto', 'the caller-supplied claim is preserved for audit, not silently dropped');
  assert.match(result.summary ?? '', /would claim t_abc123 for coo/, 'the summary itself reflects the true, token-bound holder');
});

test('a cro-lane token cannot park a claim under "cfo" either -- this is not a cto-specific special case', async () => {
  const result = await handleTaskClaim(baseInput({ agent: 'cfo' }), fakeCtx('cro'));
  const data = result.data as { preview: { agent: string }; claimed_actor?: string };
  assert.equal(data.preview.agent, 'cro');
  assert.equal(data.claimed_actor, 'cfo');
});
