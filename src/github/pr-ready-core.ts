/**
 * Pure admission core for marking a GitHub draft pull request ready for review.
 * The GitHub API has no conditional PATCH keyed by head SHA, so the core performs
 * a second read immediately before the write and verifies the response afterwards.
 * A changed head is rejected before mutation and a post-write change is reported
 * as a race instead of being presented as a successful admission.
 */

export type ReadyPullRequest = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  headSha: string;
  htmlUrl?: string;
};

export type ReadyResult = {
  executed: boolean;
  dry_run: boolean;
  number: number;
  state: string;
  draft: boolean;
  head_sha: string;
  url?: string;
};

export class PrReadyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrReadyError';
    this.code = code;
  }
}

export type ReadyDeps = {
  read: () => Promise<ReadyPullRequest>;
  update: () => Promise<ReadyPullRequest>;
};

function validate(input: { owner: string; repo: string; pullNumber: number; expectedHeadSha: string }): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repo)) {
    throw new PrReadyError('github_invalid_repository', 'Refusing an invalid GitHub repository selector.');
  }
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new PrReadyError('github_invalid_pull_request_number', 'Refusing an invalid GitHub pull request number.');
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) {
    throw new PrReadyError('github_invalid_expected_head_sha', 'Refusing an invalid expected pull request head SHA.');
  }
}

function assertAdmissible(pr: ReadyPullRequest, expectedHeadSha: string): void {
  if (pr.merged) throw new PrReadyError('github_pr_already_merged', 'The pull request is already merged.');
  if (pr.state !== 'open') throw new PrReadyError('github_pr_not_open', 'The pull request is not open.');
  if (!pr.draft) throw new PrReadyError('github_pr_not_draft', 'The pull request is already ready for review.');
  if (pr.headSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new PrReadyError('github_pr_head_mismatch', 'The pull request head changed since the expected SHA was captured.');
  }
}

export async function markDraftReadyForReview(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  dryRun: boolean;
}, deps: ReadyDeps): Promise<ReadyResult> {
  validate(input);
  const before = await deps.read();
  assertAdmissible(before, input.expectedHeadSha);

  // Close the read/write race as far as GitHub's non-conditional PATCH permits.
  const preflight = await deps.read();
  assertAdmissible(preflight, input.expectedHeadSha);

  if (input.dryRun) {
    return { executed: false, dry_run: true, number: preflight.number, state: preflight.state, draft: preflight.draft, head_sha: preflight.headSha, url: preflight.htmlUrl };
  }

  const after = await deps.update();
  if (after.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
    throw new PrReadyError('github_pr_head_race', 'The pull request head changed during the ready-for-review operation.');
  }
  if (after.merged || after.state !== 'open' || after.draft) {
    throw new PrReadyError('github_pr_ready_postcondition_failed', 'The pull request did not satisfy the ready-for-review postcondition.');
  }
  return { executed: true, dry_run: false, number: after.number, state: after.state, draft: after.draft, head_sha: after.headSha, url: after.htmlUrl };
}
