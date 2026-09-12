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
