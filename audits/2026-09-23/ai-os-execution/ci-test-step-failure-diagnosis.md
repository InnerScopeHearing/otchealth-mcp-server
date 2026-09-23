# Hosted CI Test-step failure diagnosis

Date: 2026-09-23 UTC
Repository: `InnerScopeHearing/otchealth-mcp-server`
Scope: read-only diagnosis of hosted CI runs. No test, CI, application, coverage,
credential, provider, billing, deployment, or GraphRAG state was changed.

## Conclusion

The failure is proven to be inside the `Test` step (`npm test`) after successful
checkout, Node setup, frozen install, PostgreSQL startup/TLS check, typecheck, and
build. A precise failing test or root cause is **not proven** because public GitHub
job annotations/logs are unavailable to this caller. The job-log endpoint returns
HTTP 403 for both failed and green jobs. No error text is inferred from the status.

The workflow and package test command are identical across the cited controls:

| Evidence | Result | Workflow blob | package.json blob | Test command |
| --- | --- | --- | --- | --- |
| Main run `35819084708`, head `e40ff394ad3b1b87d50a61b7bdc50d181cfbedfb` | success | `c41decb9efd3767b4572bc1db2c0c747c0679c29` | `4eb77991817eefdb0a56d49df8777380e7b21f73` | `node --test --import tsx 'src/**/*.test.ts' 'src/**/*.test.mjs'` |
| PR #450 run `35819623255`, head `f3e79c1039088f3269313b3c95733fe95186119f` | success | same | same | same |
| PR #449 run `35818769753`, job `107051570546`, head `71017d049a6ae1aac6f78730c437047d1dfda7d6` | failure | same | same | same |
| PR #451 run `35823535147`, job `107060348664`, head `79b027fd763c37ee1e5c2fc033897be1b5153c4f` | failure | same | same | same |

Public step metadata for each run is identical through `Build`; only `Test` differs:

`Set up job`, checkout, setup-node, `Install (frozen lockfile)`, `Start PostgreSQL
(for the agentstate inbox tests)`, `Typecheck`, and `Build` are `success` in all
four jobs. `Test` is `success` for runs `35819084708` and `35819623255`, and
`failure` for jobs `107051570546` and `107060348664`.

## Source and isolation observations

* `.github/workflows/ci.yml` starts the runner's preinstalled PostgreSQL service,
  sets the local `postgres` password, creates `agentstate_test`, and asserts TLS is
  enabled before running tests. This exact file has the same Git blob SHA at all
  four heads.
* `package.json` uses Node's test runner with `tsx` and discovers all
  `src/**/*.test.ts` and `src/**/*.test.mjs` files. This exact file has the same
  blob SHA at all four heads.
* PostgreSQL-backed tests intentionally use a real local database and several files
  set process environment before importing modules. The suite includes explicit
  `resetPoolForTests()` calls and separate unreachable/missing-table/DDL-denied
  cases. These are legitimate isolation-sensitive areas, but the public evidence
  does not establish that any one of them failed.
* PR #449 changes nine files, including new `src/github/pr-ready-core.test.ts`,
  governance assertions, and GitHub tool code. PR #451 changes five files,
  including `src/azure/foundry.test.ts`, `src/azure/foundry.ts`, and a new
  `src/azure/retired-foundry.test.ts`. Neither PR changes the workflow or package
  test command.
* PR #450 is a useful green control with six changed files, including Azure
  retirement tests, and its full hosted job is green. This reduces, but does not
  eliminate, the possibility of a generic hosted-runner or PostgreSQL setup issue.

## Local reproduction status

The available local checkout is a separate CTO working branch at
`1c86ce2cd4cf22bbaabae7bb83bf0c37990ee340`, not any of the four cited heads. It has
no `node_modules`, and this Windows environment has Node `v24.19.0` but no `npm`
executable. A local suite run therefore cannot be treated as a reproduction. No
dependency install or network package mutation was attempted.

## Missing evidence and smallest safe next action

Missing evidence is the failing `npm test` stdout/stderr, failed test name(s), exit
code, and per-test timing from jobs `107051570546` and `107060348664`. The smallest
safe next action is for an authorized GitHub maintainer to download the retained job
logs or rerun the exact commit with logs visible, then capture only the failing test
names and redacted error/stack. Do not alter tests, workflow, coverage, or behavior
until that evidence identifies a deterministic defect.

## Source references

* Workflow: https://github.com/InnerScopeHearing/otchealth-mcp-server/blob/e40ff394ad3b1b87d50a61b7bdc50d181cfbedfb/.github/workflows/ci.yml
* Package command: https://github.com/InnerScopeHearing/otchealth-mcp-server/blob/e40ff394ad3b1b87d50a61b7bdc50d181cfbedfb/package.json
* Failed PR #449: https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/449/checks
* Failed PR #451: https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/451/checks
* Green PR #450: https://github.com/InnerScopeHearing/otchealth-mcp-server/pull/450/checks
* Green main run: https://github.com/InnerScopeHearing/otchealth-mcp-server/actions/runs/35819084708
