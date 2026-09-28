# Weekly continuity canary — 2026-09-28

- Validation command: `node --test infra/aws/iam.relationship-artifact-versions.test.mjs`
- Result: passed — 2 tests passed, 0 failed (60.546 ms).
- Scope: local fixture only; no external services were contacted and no source defect was found.

## Environment note

- Attempted focused TypeScript test: `node --test --import tsx src/util/fetch-budget.test.ts`
- Result: could not start because this checkout has no installed `tsx` package (`ERR_MODULE_NOT_FOUND`). This is an environment prerequisite issue; no source change was made.
