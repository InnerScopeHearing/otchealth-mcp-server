import assert from 'node:assert/strict';
import test from 'node:test';
import { markDraftPullRequestReady, PrMarkReadyError, type PullRequestSnapshot } from './pr-mark-ready-core.js';

const draft = (): PullRequestSnapshot => ({
  number: 327,
  state: 'open',
  draft: true,
  merged: false,
  nodeId: 'PR_kwDOExample',
  url: 'https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/327',
});

const run = (overrides: Partial<Parameters<typeof markDraftPullRequestReady>[0]> = {}, deps?: Parameters<typeof markDraftPullRequestReady>[1]) =>
  markDraftPullRequestReady({ owner: 'InnerScopeHearing', repo: 'otchealth-mcp-server', pullNumber: 327, dryRun: true, ...overrides }, deps ?? {
    read: async () => draft(),
    mutate: async () => ({ number: 327, state: 'open', draft: false, merged: false }),
  });

test('dry run checks the target and does not invoke the mutation', async () => {
  let mutations = 0;
  const result = await run({}, {
    read: async () => draft(),
    mutate: async () => { mutations++; return { number: 327, state: 'open', draft: false, merged: false }; },
  });
  assert.deepEqual(result, { executed: false, dry_run: true, number: 327, state: 'open', draft: true, url: draft().url });
  assert.equal(mutations, 0);
});

for (const [name, value, code] of [
  ['closed PR', { ...draft(), state: 'closed' }, 'github_pr_not_open'],
  ['merged PR', { ...draft(), merged: true }, 'github_pr_already_merged'],
  ['already-ready PR', { ...draft(), draft: false }, 'github_pr_not_draft'],
] as const) {
  test(`refuses a ${name} before mutation`, async () => {
    let mutations = 0;
    await assert.rejects(() => run({}, {
      read: async () => value,
      mutate: async () => { mutations++; return { number: 327, state: 'open', draft: false, merged: false }; },
    }), (error: unknown) => error instanceof PrMarkReadyError && error.code === code);
    assert.equal(mutations, 0);
  });
}

test('invokes the fixed mutation exactly once and verifies the final state', async () => {
  let reads = 0;
  let mutations = 0;
  const result = await run({ dryRun: false }, {
    read: async () => {
      reads++;
      return reads === 1 ? draft() : { ...draft(), draft: false };
    },
    mutate: async () => {
      mutations++;
      return { number: 327, state: 'open', draft: false, merged: false };
    },
  });
  assert.equal(mutations, 1);
  assert.equal(reads, 2);
  assert.equal(result.executed, true);
  assert.equal(result.draft, false);
});

test('does not retry a failed mutation', async () => {
  let mutations = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => draft(),
    mutate: async () => { mutations++; throw new Error('provider failed'); },
  }), /provider failed/);
  assert.equal(mutations, 1);
});

test('rejects a failed final verification instead of reporting success', async () => {
  let reads = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => {
      reads++;
      return reads === 1 ? draft() : { ...draft(), draft: true };
    },
    mutate: async () => ({ number: 327, state: 'open', draft: false, merged: false }),
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_ready_postcondition_failed');
});
