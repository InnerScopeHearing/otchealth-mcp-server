import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskCreate, type TaskCreateInput } from './task-create.js';
import type { ToolContext } from '../registry.js';

// Handler-level tests through the ACTUAL registered entry point (mirrors memory-write.test.ts's
// handleMemoryWrite pattern) -- so this stays a regression on the REGISTERED handler, not only on
// resolveAttribution's own pure-function tests (attribution.test.ts).
//
// isConfigured() is checked BEFORE ctx.dryRun in handleTaskCreate, so loadEnv() must resolve with
// STATE_BACKEND's default ('postgres') satisfied via PG_HOST -- otherwise every test below would
// stop at "Cosmos not configured" rather than exercising the dry_run preview each test targets.
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

function baseInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return { title: 'do the thing', owner_agent: 'developer', created_by: 'cto', ...overrides };
}

test('a genuine self-report (created_by matches the caller token) is recorded as-is, no claimed_actor', async () => {
  const result = await handleTaskCreate(baseInput({ created_by: 'cto' }), fakeCtx('cto'));
  const data = result.data as { preview: { created_by: string }; claimed_actor?: string };
  assert.equal(data.preview.created_by, 'cto');
  assert.equal(data.claimed_actor, undefined);
});

test('SAFETY-CRITICAL: a connector-lane token (coo) claiming created_by "cto" is recorded under its REAL lane, with the claim preserved for audit', async () => {
  const result = await handleTaskCreate(baseInput({ created_by: 'cto' }), fakeCtx('coo'));
  const data = result.data as { preview: { created_by: string }; claimed_actor?: string };
  assert.equal(data.preview.created_by, 'coo', 'the ledger-bound created_by must be the token-bound lane, never the caller-supplied claim');
  assert.equal(data.claimed_actor, 'cto', 'the caller-supplied claim is preserved for audit, not silently dropped');
  assert.match(result.summary ?? '', /created_by=coo/, 'the summary itself reflects the true, token-bound attribution');
});

test('owner_agent (the reassignment target) is completely untouched by the attribution fix -- it is not an identity claim', async () => {
  const result = await handleTaskCreate(baseInput({ owner_agent: 'developer', created_by: 'coo' }), fakeCtx('coo'));
  const data = result.data as { preview: { owner_agent: string } };
  assert.equal(data.preview.owner_agent, 'developer');
});

test('a human shorthand ("matt") that disagrees with the caller token is preserved as claimed_actor, not rejected outright (this is attribution, not a hard security wall)', async () => {
  const result = await handleTaskCreate(baseInput({ created_by: 'matt' }), fakeCtx('cto'));
  const data = result.data as { preview: { created_by: string }; claimed_actor?: string; created: boolean };
  assert.equal(data.created, false, 'still a dry run: this test only proves the call is NOT refused, not that it persists');
  assert.equal(data.preview.created_by, 'cto');
  assert.equal(data.claimed_actor, 'matt');
});

// NOTE: a "not configured" (isConfigured()===false) handler test is deliberately not included here
// -- src/config/env.ts's loadEnv() memoizes its parsed result for the process lifetime (`if (cached)
// return cached`), so PG_HOST cannot be toggled mid-suite once any test in this process has already
// resolved it. memory-write.test.ts hits the identical constraint and takes the same approach: every
// handler-level test here exercises a dry_run path that runs BEFORE any real Cosmos/Postgres call,
// which is also exactly what proves the attribution fix without needing a live store.
