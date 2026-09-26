export const PR_MARK_READY_ALLOWED_TARGET = Object.freeze({
  owner: 'InnerScopeHearing',
  repo: 'otchealth-cto',
  pullNumber: 712,
});

const FULL_SHA = /^[0-9a-f]{40}$/i;

export type PullRequestSnapshot = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  nodeId: string;
  headSha: string;
  url?: string;
};

export type MarkReadyResult = {
  executed: boolean;
  dry_run: boolean;
  number: number;
  state: string;
  draft: boolean;
  head_sha: string;
  url?: string;
};

export class PrMarkReadyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrMarkReadyError';
    this.code = code;
  }
}

export type MarkReadyMutationResult = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
  url?: string;
};

export type MarkReadyDeps = {
  read: () => Promise<PullRequestSnapshot>;
  mutate: (
    nodeId: string,
    expectedNumber: number,
    expectedHeadSha: string,
    expectedRepositoryFullName: string,
  ) => Promise<MarkReadyMutationResult>;
};

function validate(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
}): void {
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  if (!segment.test(input.owner) || !segment.test(input.repo)) {
    throw new PrMarkReadyError('github_invalid_repository', 'Refusing an invalid GitHub repository selector.');
  }
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new PrMarkReadyError('github_invalid_pull_request_number', 'Refusing an invalid GitHub pull request number.');
  }
  if (
    input.owner.toLowerCase() !== PR_MARK_READY_ALLOWED_TARGET.owner.toLowerCase()
    || input.repo.toLowerCase() !== PR_MARK_READY_ALLOWED_TARGET.repo.toLowerCase()
    || input.pullNumber !== PR_MARK_READY_ALLOWED_TARGET.pullNumber
  ) {
    throw new PrMarkReadyError('github_pr_target_not_allowed', 'This action is limited to the reviewed company cost and usage pull request.');
  }
  if (typeof input.expectedHeadSha !== 'string' || !FULL_SHA.test(input.expectedHeadSha)) {
    throw new PrMarkReadyError('github_expected_head_sha_invalid', 'Provide the full 40-character expected pull request head SHA.');
  }
}

function assertDraft(pr: PullRequestSnapshot, number: number, expectedHeadSha: string): void {
  if (pr.number !== number) throw new PrMarkReadyError('github_pr_identity_mismatch', 'The GitHub response did not identify the requested pull request.');
  if (pr.merged) throw new PrMarkReadyError('github_pr_already_merged', 'The pull request is already merged.');
  if (pr.state.toLowerCase() !== 'open') throw new PrMarkReadyError('github_pr_not_open', 'The pull request is not open.');
  if (!pr.draft) throw new PrMarkReadyError('github_pr_not_draft', 'The pull request is already ready for review.');
  if (!pr.nodeId) throw new PrMarkReadyError('github_pr_identity_missing', 'The pull request identity is unavailable.');
  if (!FULL_SHA.test(pr.headSha) || pr.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new PrMarkReadyError('github_pr_head_sha_mismatch', 'The pull request head does not match the full expected SHA.');
  }
}

function assertReady(
  pr: { number: number; state: string; draft: boolean; merged: boolean; headSha: string },
  number: number,
  expectedHeadSha: string,
  code = 'github_pr_ready_postcondition_failed',
): void {
  if (
    pr.number !== number
    || pr.merged
    || pr.state.toLowerCase() !== 'open'
    || pr.draft
    || !FULL_SHA.test(pr.headSha)
    || pr.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()
  ) {
    throw new PrMarkReadyError(code, 'The pull request did not satisfy the same-head ready-for-review postcondition.');
  }
}

export async function markDraftPullRequestReady(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  dryRun: boolean;
}, deps: MarkReadyDeps): Promise<MarkReadyResult> {
  validate(input);
  const before = await deps.read();
  assertDraft(before, input.pullNumber, input.expectedHeadSha);
  if (input.dryRun) {
    return {
      executed: false,
      dry_run: true,
      number: before.number,
      state: before.state,
      draft: before.draft,
      head_sha: before.headSha,
      url: before.url,
    };
  }

  // Exactly one mutation. Do not retry a potentially completed state change.
  const mutation = await deps.mutate(
    before.nodeId,
    input.pullNumber,
    input.expectedHeadSha,
    `${input.owner}/${input.repo}`,
  );
  assertReady(mutation, input.pullNumber, input.expectedHeadSha);
  const verified = await deps.read();
  assertReady(verified, input.pullNumber, input.expectedHeadSha);
  return {
    executed: true,
    dry_run: false,
    number: verified.number,
    state: verified.state,
    draft: verified.draft,
    head_sha: verified.headSha,
    url: verified.url,
  };
}
