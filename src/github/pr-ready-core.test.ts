import assert from 'node:assert/strict';
import test from 'node:test';
import { markDraftReadyForReview, PrReadyError, type ReadyPullRequest } from './pr-ready-core.js';

const sha = 'a'.repeat(40);
const base = (): ReadyPullRequest => ({ number: 676, state: 'open', draft: true, merged: false, headSha: sha, htmlUrl: 'https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/676' });
const run = async (overrides: Partial<Parameters<typeof markDraftReadyForReview>[0]> = {}, deps?: { read: () => Promise<ReadyPullRequest>; update: () => Promise<ReadyPullRequest> }) => markDraftReadyForReview({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pullNumber: 676, expectedHeadSha: sha, dryRun: true, ...overrides }, deps ?? { read: async () => base(), update: async () => ({ ...base(), draft: false }) });

test('dry run performs both admission reads and never updates', async () => {
  let reads = 0; let updates = 0;
  const result = await run({}, { read: async () => { reads++; return base(); }, update: async () => { updates++; return { ...base(), draft: false }; } });
  assert.equal(result.executed, false); assert.equal(result.dry_run, true); assert.equal(reads, 2); assert.equal(updates, 0);
});

test('applies only after open draft and expected head admission', async () => {
  let updates = 0;
  const result = await run({ dryRun: false }, { read: async () => base(), update: async () => { updates++; return { ...base(), draft: false }; } });
  assert.equal(result.executed, true); assert.equal(result.draft, false); assert.equal(updates, 1);
});

for (const [name, pr, code] of [
  ['closed', { ...base(), state: 'closed' }, 'github_pr_not_open'],
  ['merged', { ...base(), merged: true }, 'github_pr_already_merged'],
  ['already ready', { ...base(), draft: false }, 'github_pr_not_draft'],
  ['head mismatch', { ...base(), headSha: 'b'.repeat(40) }, 'github_pr_head_mismatch'],
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(() => run({}, { read: async () => pr, update: async () => ({ ...pr, draft: false }) }), (e: unknown) => e instanceof PrReadyError && e.code === code);
  });
}

test('rejects a head race detected by the second admission read', async () => {
  let reads = 0;
  await assert.rejects(() => run({}, { read: async () => { reads++; return reads === 1 ? base() : { ...base(), headSha: 'b'.repeat(40) }; }, update: async () => ({ ...base(), draft: false }) }), (e: unknown) => e instanceof PrReadyError && e.code === 'github_pr_head_mismatch');
});

test('rejects a post-write head race and never reports success', async () => {
  await assert.rejects(() => run({ dryRun: false }, { read: async () => base(), update: async () => ({ ...base(), draft: false, headSha: 'b'.repeat(40) }) }), (e: unknown) => e instanceof PrReadyError && e.code === 'github_pr_head_race');
});

test('rejects malformed selectors and SHA', async () => {
  await assert.rejects(() => run({ owner: 'bad/owner' }), (e: unknown) => e instanceof PrReadyError && e.code === 'github_invalid_repository');
  await assert.rejects(() => run({ expectedHeadSha: 'not-a-sha' }), (e: unknown) => e instanceof PrReadyError && e.code === 'github_invalid_expected_head_sha');
});

test('result and errors are secret-free and do not expose arbitrary response fields', async () => {
  const result = await run();
  assert.equal(JSON.stringify(result).includes('token'), false);
  assert.deepEqual(Object.keys(result).sort(), ['draft', 'dry_run', 'executed', 'head_sha', 'number', 'state', 'url']);
});
