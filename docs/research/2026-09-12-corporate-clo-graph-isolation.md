# Corporate CLO Graph isolation report

Date: 2026-09-12

Scope: corporate CLO graph wiring and isolation only. No source documents, personal legal content,
credentials, or live infrastructure writes were used.

## Evidence reviewed

- `src/server/company-graph-scope.ts` already defines closed company scopes. `finance` binds only
  to `cfo`; `legal_company` binds only to `clo`; personal legal is absent from the company table.
- `src/tools/kb/brain-search.ts` gates `legal-personal` and `legal-personal-memory` through
  `PERSONAL_LEGAL_RING`. A corporate CLO legal-domain request resolves only to `legal-company`.
- The reported corporate CLO `brain_search` correlation searched company legal, finance, and open
  rooms. It did not include a personal legal room. That correlation alone cannot establish the
  origin of any separately reported wake content.
- The shared-memory feed still permits historical rows whose agent is `clo-personal`. Before this
  change, `memory_team` returned all rows, `memory_recall` accepted an arbitrary agent filter and
  did not post-filter semantic results, and `memory_inbound` and `memory_reconcile` accepted an
  arbitrary target ledger.
- Graph Drive folder routing treated `clo-personal` as `clo`, allowing the corporate CLO identity
  to address the same CLO folder namespace.

## Implemented controls

- Added `shared-memory-access.ts`. Corporate callers cannot request or receive
  `clo-personal` shared-memory rows, including rows returned by semantic and agentic recall.
- Bound inbound reads and reconciliation writes to the authenticated caller's own ledger.
- Split Drive routing: company folders use `CLO ...`; personal folders use `CLO Personal ...`.
  The corporate CLO lane is refused from the personal namespace.
- Extended the graph query input with the server-owned `legal_company` scope. Only `clo` can use
  that scope; CFO retains the default finance scope. Cross-scope and personal requests are refused.
- Corporate CLO publication-policy entries require an explicit triple:
  `scope=legal_company`, `room=legal_company`, `source_index=legal-company`.
  A generic `clo` policy entry cannot be accepted.

## Validation

- TypeScript: `tsc --noEmit -p tsconfig.json` passed.
- Focused isolation suite: 42 tests passed. It covered corporate CLO wake lane selection, legal
  brain room selection, historical personal shared-memory fixtures, Drive namespace separation,
  company graph scope resolution, query entry-point authorization, and existing CFO publication
  policy behavior.
- Related publication suite: 23 tests passed, 3 existing integration tests skipped by their own
  environment gate.

## Remaining delivery prerequisites

1. The relationship historical-read and currentness routes, plus version-pinned text preparation,
   still validate only CFO and finance artifacts. They must be parameterized by the closed company
   scope table before a CLO publication can be accepted end-to-end.
2. A legal-company catalog, version-pinned source metadata, CLO worker artifact store binding,
   publication/history policy binding, identity-currentness configuration, and a scoped runtime
   credential set are not present in this change. No live CLO graph run is configured or claimed.
3. Personal legal graph processing remains outside the company table. It requires its own
   privileged runtime, source and worker stores, credentials, encryption authority, catalog, and
   identity registry. Reusing only pure validation code is permissible; sharing company runtime
   authorities is not.
