# GitHub PR ready-for-review bridge worker receipt

Date: 2026-09-23 UTC
Worker: Luna bounded implementation worker
Ledger task: `t_idem_24349f75`
Repository: `InnerScopeHearing/otchealth-mcp-server`
Branch: `claude/ai-os-github-pr-ready-bridge-20260923`
Target acceptance fixture: existing draft PR #676

## Scope completed

Implemented one narrow CTO-gated operation, `github_pr_ready_for_review`. It accepts only an owner, repository, pull request number, and exact expected head SHA. It reads the pull request, verifies it is open, unmerged, still a draft, and still at the expected head. It repeats the admission read immediately before the write, defaults to dry-run, and validates a safe postcondition after the write. It cannot merge, approve, alter branches, or dispatch workflows.

The tool is registered in the gateway registry and CTO curated surface, with an explicit CTO-only governance rule. The underlying GitHub update client accepts only the fixed `draft:false` operation from this tool's adapter. No generic GitHub path or arbitrary request surface was added.

## Exact diff

- `src/github/pr-ready-core.ts`: pure admission and race/postcondition core.
- `src/github/pr-ready-core.test.ts`: ten tests covering dry-run, execution, closed, merged, already-ready, head mismatch, read race, post-write race, malformed selectors, and output redaction.
- `src/tools/github/pr-ready-for-review.ts`: MCP schema, fixed GitHub adapter, safe audit output.
- `src/github/full-client.ts`: adds the narrowly used `draft` field to the existing PR PATCH client.
- `src/tools/index.ts`: registers the tool.
- `src/tools/registry.ts`: includes the tool in the write registry.
- `src/catalog/governance.ts`: explicit CTO-only rule.
- `src/catalog/governance.test.ts`: locks the CTO-only rule and rejects developer and other lanes.

## Verification

- `pnpm exec tsx src/github/pr-ready-core.test.ts`: 10 passed, 0 failed.
- `pnpm exec tsx --test src/catalog/governance.test.ts`: 6 passed, 0 failed.
- `pnpm exec tsc -p tsconfig.json --noEmit`: passed.
- `git diff --check`: passed.
- No live GitHub mutation was performed. The target PR #676 remains a draft until the parent conductor completes review, creates a draft PR for this branch, and separately authorizes a real post-deploy acceptance call with its verified head SHA.

## Security and redaction

No credential values, installation tokens, headers, private keys, PHI, or response bodies are returned or written. The audit payload contains only safe status fields, number, SHA, and GitHub URL. Repository safety continues to reject PHI repository writes.

## Rollback

Rollback is a draft PR close/delete decision owned by the parent conductor. If merged, revert this commit and deploy the prior immutable gateway image through the normal ECS rollback procedure. Do not use the operation to close or merge the PR. No AWS, GitHub PR state, catalog deployment, or credential change occurred in this worker turn.

## Live acceptance plan for draft PR #676

1. Parent conductor verifies PR #676 is open, draft, unmerged, and records its current exact head SHA through an independent read.
2. After the branch is reviewed and deployed through the normal gateway release gates, call the tool with that exact SHA and default dry-run. Confirm two reads occurred, `executed:false`, and PR state is unchanged.
3. After explicit CTO authorization, repeat with `dry_run:false`. Confirm the response is `executed:true`, `draft:false`, state `open`, and the same head SHA. Independently read PR #676 and confirm ready status.
4. Negative controls: stale SHA must fail before mutation, closed or merged PR must fail, already-ready PR must fail, non-CTO caller must be refused, and no merge/review/branch operation may be emitted.
5. Record the deployed image digest, live catalog presence, caller identity, request correlation, redacted audit receipt, and independent GitHub read in the parent ledger. Keep this worker receipt as code-ready evidence until all live gates pass.
