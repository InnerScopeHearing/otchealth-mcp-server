import assert from 'node:assert/strict';
import test from 'node:test';
import { markDraftPullRequestReady, PR_MARK_READY_ALLOWED_TARGET, PrMarkReadyError, type PullRequestSnapshot } from './pr-mark-ready-core.js';

const EXPECTED_HEAD_SHA = 'a'.repeat(40);
const changedHeadSha = 'b'.repeat(40);

const draft = (headSha = EXPECTED_HEAD_SHA): PullRequestSnapshot => ({
  number: PR_MARK_READY_ALLOWED_TARGET.pullNumber,
  state: 'open',
  draft: true,
  merged: false,
  nodeId: 'PR_kwDOExample',
  headSha,
  url: `https://github.com/${PR_MARK_READY_ALLOWED_TARGET.owner}/${PR_MARK_READY_ALLOWED_TARGET.repo}/pull/${PR_MARK_READY_ALLOWED_TARGET.pullNumber}`,
});

const readyMutation = (headSha = EXPECTED_HEAD_SHA) => ({
  number: PR_MARK_READY_ALLOWED_TARGET.pullNumber,
  state: 'open',
  draft: false,
  merged: false,
  headSha,
});

const run = (
  overrides: Partial<Parameters<typeof markDraftPullRequestReady>[0]> = {},
  deps?: Parameters<typeof markDraftPullRequestReady>[1],
) => markDraftPullRequestReady({
  owner: PR_MARK_READY_ALLOWED_TARGET.owner,
  repo: PR_MARK_READY_ALLOWED_TARGET.repo,
  pullNumber: PR_MARK_READY_ALLOWED_TARGET.pullNumber,
  expectedHeadSha: EXPECTED_HEAD_SHA,
  dryRun: true,
  ...overrides,
}, deps ?? {
  read: async () => draft(),
  mutate: async () => readyMutation(),
});

test('dry run checks the exact target and head SHA without invoking the mutation', async () => {
  let mutations = 0;
  const result = await run({}, {
    read: async () => draft(),
    mutate: async () => { mutations++; return readyMutation(); },
  });
  assert.deepEqual(result, {
    executed: false,
    dry_run: true,
    number: PR_MARK_READY_ALLOWED_TARGET.pullNumber,
    state: 'open',
    draft: true,
    head_sha: EXPECTED_HEAD_SHA,
    url: draft().url,
  });
  assert.equal(mutations, 0);
});

for (const [name, overrides] of [
  ['wrong owner', { owner: 'OtherOrg' }],
  ['wrong repository', { repo: 'otchealth-mcp-server' }],
  ['wrong pull request', { pullNumber: PR_MARK_READY_ALLOWED_TARGET.pullNumber + 1 }],
] as const) {
  test(`rejects a ${name} before reading or mutating GitHub`, async () => {
    let reads = 0;
    let mutations = 0;
    await assert.rejects(() => run(overrides, {
      read: async () => { reads++; return draft(); },
      mutate: async () => { mutations++; return readyMutation(); },
    }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_target_not_allowed');
    assert.equal(reads, 0);
    assert.equal(mutations, 0);
  });
}

test('rejects a missing expected head SHA before reading GitHub', async () => {
  let reads = 0;
  await assert.rejects(() => run({ expectedHeadSha: undefined as unknown as string }, {
    read: async () => { reads++; return draft(); },
    mutate: async () => readyMutation(),
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_expected_head_sha_invalid');
  assert.equal(reads, 0);
});

test('rejects an abbreviated or malformed expected head SHA', async () => {
  let reads = 0;
  await assert.rejects(() => run({ expectedHeadSha: EXPECTED_HEAD_SHA.slice(0, 12) }, {
    read: async () => { reads++; return draft(); },
    mutate: async () => readyMutation(),
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_expected_head_sha_invalid');
  assert.equal(reads, 0);
});

test('rejects a mismatched mutation response SHA', async () => {
  let mutations = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => draft(),
    mutate: async () => { mutations++; return readyMutation(changedHeadSha); },
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_ready_postcondition_failed');
  assert.equal(mutations, 1);
});

test('rejects a stale expected SHA before the mutation', async () => {
  let mutations = 0;
  await assert.rejects(() => run({ expectedHeadSha: EXPECTED_HEAD_SHA }, {
    read: async () => draft(changedHeadSha),
    mutate: async () => { mutations++; return readyMutation(); },
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_head_sha_mismatch');
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
      mutate: async () => { mutations++; return readyMutation(); },
    }), (error: unknown) => error instanceof PrMarkReadyError && error.code === code);
    assert.equal(mutations, 0);
  });
}

test('invokes one mutation and verifies the same head SHA on the final read', async () => {
  let reads = 0;
  let mutations = 0;
  const result = await run({ dryRun: false }, {
    read: async () => {
      reads++;
      return reads === 1 ? draft() : { ...draft(), draft: false };
    },
    mutate: async (nodeId, expectedNumber, expectedHeadSha, expectedRepositoryFullName) => {
      mutations++;
      assert.equal(nodeId, 'PR_kwDOExample');
      assert.equal(expectedNumber, PR_MARK_READY_ALLOWED_TARGET.pullNumber);
      assert.equal(expectedHeadSha, EXPECTED_HEAD_SHA);
      assert.equal(expectedRepositoryFullName, `${PR_MARK_READY_ALLOWED_TARGET.owner}/${PR_MARK_READY_ALLOWED_TARGET.repo}`);
      return readyMutation();
    },
  });
  assert.equal(mutations, 1);
  assert.equal(reads, 2);
  assert.deepEqual(result, {
    executed: true,
    dry_run: false,
    number: PR_MARK_READY_ALLOWED_TARGET.pullNumber,
    state: 'open',
    draft: false,
    head_sha: EXPECTED_HEAD_SHA,
    url: draft().url,
  });
});

test('rejects SHA drift on the post-mutation read', async () => {
  let reads = 0;
  let mutations = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => {
      reads++;
      return reads === 1 ? draft() : { ...draft(changedHeadSha), draft: false };
    },
    mutate: async () => { mutations++; return readyMutation(); },
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_ready_postcondition_failed');
  assert.equal(reads, 2);
  assert.equal(mutations, 1);
});

test('does not retry a failed mutation', async () => {
  let mutations = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => draft(),
    mutate: async () => { mutations++; throw new Error('provider failed'); },
  }), /provider failed/);
  assert.equal(mutations, 1);
});

test('rejects a final read that is still draft', async () => {
  let reads = 0;
  await assert.rejects(() => run({ dryRun: false }, {
    read: async () => {
      reads++;
      return reads === 1 ? draft() : draft();
    },
    mutate: async () => readyMutation(),
  }), (error: unknown) => error instanceof PrMarkReadyError && error.code === 'github_pr_ready_postcondition_failed');
  assert.equal(reads, 2);
});
