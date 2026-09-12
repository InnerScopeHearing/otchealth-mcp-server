# Independent corporate CLO graph isolation review

Date: 2026-09-12

Review scope: the corporate CLO graph isolation branch. No company source record, personal legal
record, credential, or live infrastructure operation was accessed.

## Findings addressed

1. Corporate CLO graph scope was accepted at the public query surface while replay and historical
   validation still depended on CFO and finance fields. This remains the end-to-end delivery
   blocker and is being generalized on the dependent replay branch.
2. The automatic relationship artifact binding must bind the authenticated caller and closed graph
   scope together with the existing caller hash, cohort, producer, purpose, and run version.
3. Shared-memory agentic recall filtered personal rows from its response but retained the
   pre-filter total in the summary. The summary now uses the same filtered collection as the
   payload, preventing count-based disclosure of personal rows.

## Confirmed isolation controls

- Corporate `clo` wakes only its own lane and legal brain retrieval selects `legal-company`, not
  personal legal rooms.
- `memory_team`, `memory_recall`, inbound notes, and reconciliation prevent corporate CLO access
  to historical `clo-personal` shared-memory rows.
- `CLO Personal ...` Drive folders are distinct from corporate `CLO ...` folders.
- CFO remains bound to finance. A CLO request for finance and a CFO request for corporate legal are
  refused by the company graph scope table.

## Evidence and validation

- Independent review suite result supplied to this task: 61 passed, 2 environment-gated tests
  skipped. No live source or deployment was exercised.
- The branch-local focused typecheck and isolation tests also passed before this dependent replay
  extension began.

## Remaining work

The dependent replay branch must generalize durable query replay, historical-read validation,
prepared-text binding, source currentness, and automatic artifact binding to the closed
`finance`/`legal_company` scope table. It must preserve all CFO fixture behavior and prove a
synthetic corporate CLO history can replay and query while finance and personal substitutions fail.

## Dependent replay extension

The dependent branch now resolves currentness through a company-scoped, version-pinned text reader.
The reader receives a closed server-owned scope, checks the authenticated caller and exact room/index
pair, and uses that scope's dedicated source prefix. A corporate CLO reader can reach only
`otchealthlegalstore/company/`; `clo-personal`, `legal-personal`, and a finance index are refused.

The catalog planner now accepts a validated internal company scope. Finance remains its default, so
existing CFO callers retain their manifest and cursor behavior. A legal-company manifest stamps the
legal-company room and legal-company source index into its document-version authority, allowing
historical replay to reconstruct the same scope instead of silently reconstructing finance.

Focused synthetic validation passed: 47 tests passed and 2 environment-gated integration tests
skipped, plus TypeScript `--noEmit`. It includes a full synthetic CLO historical GET that verifies
immutable pins, a legal-company catalog manifest, source currentness, and personal-index rejection.
No source documents, credentials, personal legal material, or live AWS resources were accessed.

## Runtime rollout gaps

This change completes the closed planner and replay primitives, but does not activate a live CLO
publication route. `graph-catalog-controller.ts` and `graph-worker-broker.ts` still instantiate
CFO-only catalog/worker adapters and must be given a deployment-owned CLO catalog cohort and worker
configuration before live publication. The required policy pins, source catalog version, identity
registry, encryption configuration, and acceptance receipts remain deployment prerequisites. The
personal legal deployment remains a separate privileged runtime and cannot reuse any company source,
worker, identity, credential, or encryption authority.
