# AI OS CI failure-evidence capability census

Observation date: 2026-09-23 UTC
Repository: `InnerScopeHearing/otchealth-mcp-server`
Source basis: `origin/main` at `e40ff394ad3b1b87d50a61b7bdc50d181cfbedfb`.
Requested subjects: draft PR #449 and draft PR #451.

This is an evidence-only receipt. It contains no raw job-log output, source
content from the failing tests, credentials, signed URLs, or secret values.
Statements marked **inference** are conclusions from the listed observations.

## Current authorized gateway surface

The CTO gateway catalog observation returned catalog version `f51c17ed` and 70
GitHub tools. It advertises read tools for workflow-run metadata, job metadata,
and workflow-run artifact metadata:

| Capability | Current observation | Evidence | Result |
| --- | --- | --- | --- |
| Workflow-run metadata | `github_workflow_run_get` is cataloged and callable | Live calls for runs `35818769753` and `35823535147` | Available and verified |
| Job and step metadata | `github_workflow_run_list_jobs` is cataloged and callable | Live calls for both runs, latest attempt | Available and verified |
| Workflow-run artifact metadata | Catalog advertises `github_workflow_run_list_artifacts` | Catalog version `f51c17ed`; current callable namespace did not expose this function | Advertised, but unavailable in this client surface |
| GitHub job logs | No GitHub log-reader tool appears in the current GitHub catalog | Catalog inventory has no `github_*logs*` tool; source has no GitHub log-reader module | Unavailable through the authorized gateway |
| Artifact download/readback | No GitHub artifact download tool appears in the current catalog | Catalog has no artifact URL/download/read tool | Unavailable through the authorized gateway |

The live catalog and callable namespace disagree for artifact listing. **Inference:**
the server registry/source contains the artifact-list implementation, but this
client's current callable binding is stale or omitted. Calling it from this
client raised a missing-function error; no raw API fallback was attempted.

## Run and job evidence retrieved

| PR | Run | Head branch | Head SHA | Run conclusion | Job | Failed step |
| --- | ---: | --- | --- | --- | ---: | --- |
| #449 | 35818769753 | `claude/ai-os-github-pr-ready-bridge-20260923` | `71017d049a6ae1aac6f78730c437047d1dfda7d6` | `completed / failure` | 107051570546 | `Test` (step 8) |
| #451 | 35823535147 | `claude/ai-os-retired-azure-llm-guard-20260923` | `79b027fd763c37ee1e5c2fc033897be1b5153c4f` | `completed / failure` | 107060348664 | `Test` (step 8) |

The job projection returned only bounded job/step metadata. It did not return
log lines, test names, exception text, environment values, or artifact bytes.
The run metadata and step metadata are therefore sufficient to establish the
failed stage, but not its cause.

## Repository workflow and redaction evidence

The current `ci` workflow runs checkout, Node setup, frozen install, local
PostgreSQL setup, typecheck, build, and test. It does not upload an artifact:
`.github/workflows/ci.yml:21-68`.

The source registers `github_workflow_run_list_artifacts` and projects only
artifact id, name, byte size, expiry flag, and timestamps:
`src/tools/github/workflow-run-list-artifacts.ts:7-37` and
`src/tools/index.ts:340-342,1394-1397`.

The CTO ship-lane registry lists workflow-run metadata and jobs but omits the
artifact-list tool: `src/tools/registry.ts:183-193`. The default external
readonly connector set is intentionally limited to general read/search tools:
`src/tools/registry.ts:295-313`. **Inference:** source registration alone does
not prove a seat can call a tool; the live callable surface is the acceptance
boundary.

Existing artifact patterns in this repository upload bounded receipts with
explicit 30-day retention in `codex-run.yml:207-217` and
`build-gateway-ecr.yml:167-173`. These patterns do not apply to the `ci` run,
which has no upload step. No retention status for either requested run was
retrieved.

The job and artifact source projections are metadata-only and do not redact
arbitrary log text because they do not retrieve log text. **Untestable:**
whether GitHub-hosted logs for these runs are retained, whether any run
artifacts exist remotely, and whether those remote contents are safely
redacted. No raw logs or artifact contents were accessed.

## Exact next action and blockers

The owner-supported next action is to reconcile and redeploy the gateway/client
binding so that the already cataloged artifact-list tool is callable, then
perform a fresh live catalog, artifact-metadata, and redacted job-log-reader
acceptance for both run IDs. A GitHub job-log reader with bounded redaction is
also required; no such tool is present in the current source/catalog surface.

Until that repair and acceptance exist, the authorized gateway can prove only
run/job/step status. It cannot prove failure cause, log retention, artifact
availability, artifact retention, or content redaction. Browser login, raw
GitHub REST calls, reruns, workflow changes, and GitHub-state mutations were
not used.

## Validation

- `git diff --check`: passed.
- Markdown/static review: passed by inspection; the receipt contains no raw log
  output or secret-looking values.
- Branch base verified: `claude/ai-os-ci-failure-capability-census-20260923`
  from `origin/main` at `e40ff394ad3b1b87d50a61b7bdc50d181cfbedfb`.
