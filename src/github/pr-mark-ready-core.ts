export type PullRequestSnapshot = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean;
  nodeId: string;
  url?: string;
};

export type MarkReadyResult = {
  executed: boolean;
  dry_run: boolean;
  number: number;
  state: string;
  draft: boolean;
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

export type MarkReadyDeps = {
  read: () => Promise<PullRequestSnapshot>;
  mutate: (nodeId: string) => Promise<{ number: number; state: string; draft: boolean; merged: boolean; url?: string }>;
};

function validate(input: { owner: string; repo: string; pullNumber: number }): void {
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  if (!segment.test(input.owner) || !segment.test(input.repo)) {
    throw new PrMarkReadyError('github_invalid_repository', 'Refusing an invalid GitHub repository selector.');
  }
  if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new PrMarkReadyError('github_invalid_pull_request_number', 'Refusing an invalid GitHub pull request number.');
  }
}

function assertDraft(pr: PullRequestSnapshot, number: number): void {
  if (pr.number !== number) throw new PrMarkReadyError('github_pr_identity_mismatch', 'The GitHub response did not identify the requested pull request.');
  if (pr.merged) throw new PrMarkReadyError('github_pr_already_merged', 'The pull request is already merged.');
  if (pr.state !== 'open') throw new PrMarkReadyError('github_pr_not_open', 'The pull request is not open.');
  if (!pr.draft) throw new PrMarkReadyError('github_pr_not_draft', 'The pull request is already ready for review.');
  if (!pr.nodeId) throw new PrMarkReadyError('github_pr_identity_missing', 'The pull request identity is unavailable.');
}

function assertReady(pr: { number: number; state: string; draft: boolean; merged: boolean }, number: number): void {
  if (pr.number !== number || pr.merged || pr.state !== 'open' || pr.draft) {
    throw new PrMarkReadyError('github_pr_ready_postcondition_failed', 'The pull request did not satisfy the ready-for-review postcondition.');
  }
}

export async function markDraftPullRequestReady(input: {
  owner: string;
  repo: string;
  pullNumber: number;
  dryRun: boolean;
}, deps: MarkReadyDeps): Promise<MarkReadyResult> {
  validate(input);
  const before = await deps.read();
  assertDraft(before, input.pullNumber);
  if (input.dryRun) {
    return { executed: false, dry_run: true, number: before.number, state: before.state, draft: before.draft, url: before.url };
  }

  // Exactly one mutation. Do not retry a potentially completed state change.
  const mutation = await deps.mutate(before.nodeId);
  assertReady(mutation, input.pullNumber);
  const verified = await deps.read();
  assertReady(verified, input.pullNumber);
  return { executed: true, dry_run: false, number: verified.number, state: verified.state, draft: verified.draft, url: verified.url };
}
