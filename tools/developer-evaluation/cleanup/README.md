# Isolated app evaluation and cleanup contract

This small local Git-backed toolset provides a reproducible way to evaluate a Developer-owned app revision without creating a remote branch or touching the source checkout. It is separate from the pagination and runner worktrees. It changes no Developer permissions and grants no delete authority.

## Ownership and exact targets

| Object | Writer / owner | Guard and cleanup |
|---|---|---|
| Source checkout supplied with `--repo` | Developer owns source/test work; this helper only reads it | Must resolve to a local Git top level. `prepare` refuses dirty tracked or untracked prestate and records source `HEAD` plus status SHA-256. It never resets, cleans, checks out a branch, or writes to the source checkout. |
| Disposable evaluation checkout | One Developer writer for a unique `--run-id`; created only at `repair2/cleanup/worktrees/<run-id>` | Detached at a full commit SHA. Existing target/state, symlink, dirty checkout, or pin mismatch stops the operation. `cleanup` removes only this exact target using `git worktree remove` without `--force`. Any tracked/untracked changes or ignored non-build data cause refusal with target contents preserved. |
| State and logs | CTO owns cleanup evidence; Developer may inspect | State is in `state/<run-id>.json`, mode 0600. Logs are under `artifacts/<run-id>/run-NNNN/` outside the source worktree, retained after cleanup. No cleanup command deletes state or artifacts. |
| Remote branches, credentials, source permissions | No writer in this workflow | None are created, copied, changed, or deleted. The flow needs no remote probe branch. |

Cleanup accepts Git-reported ignored directories whose final component exactly matches `node_modules`, `.turbo`, `dist`, `coverage`, `playwright-report`, or `test-results`, including nested package outputs. Git reports these directories as units; their contents are disposable. Keep user files and secrets outside generated directories. Unknown ignored paths, `.env` files, arbitrary ignored files, untracked fixtures, source diffs, changed pins, locks and unexpected targets are preserved for owner review. Do not add `--force`, `rm -rf`, `git clean`, or broader patterns.

## Usage

Run from this directory with Python 3 and Git. No Python package installation is needed. Use an already available local source checkout; this contract does not fetch/copy credentials or invent a repository mirror.

```bash
python3 scripts/eval_worktree.py prepare \
  --repo /path/to/local/InnerScopeHearing/flatstick \
  --pin b017072ae13af1fb9c4ae895c42a1f16c6f826dd \
  --run-id flatstick-b017072 \
  --app Flatstick

python3 scripts/eval_worktree.py status --run-id flatstick-b017072
# The separately admitted runner runs commands in repair2/cleanup/worktrees/flatstick-b017072
# and writes command logs/readable receipts only in repair2/cleanup/artifacts/flatstick-b017072.
python3 scripts/eval_worktree.py cleanup --run-id flatstick-b017072
```

The command-runner owns the test process and all stdout/stderr/UTC/exit receipts under `artifacts/<run-id>`; this cleanup helper never launches tests or writes their logs. The runner must use mocked/local fixtures, no customer, hearing-result, child, private-photo, paid-provider, purchase, or production-write data. Do not place secret values in argv or test output. For browser smoke, use the workflow's local `E2E_BASE_URL`/localhost setup and keep any mock fixture inside the disposable worktree. To save source edits for review, export and inspect them to a separate retained patch artifact before cleanup; the cleanup command itself intentionally refuses changed source worktrees.

Use the app's exact package manager pin from its root manifest (pnpm 10.33.4 for the reviewed Flatstick, PlantID and InnerEase candidates), not the host's pnpm 11.25.0. Each `prepare` manifest captures that invocation's UTC time, OS fields, local hostname, cwd, process ID/executable/Python version, and the values declared in `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, and `CODEX_ENVIRONMENT_ID`. Environment declarations and hostname are explicitly marked observed/unverified; the tool does not prove the hosting or session binding. The root-verified CTO session/environment/host from 2026-10-04 is stored separately under `prior_verified_provenance` as historical context only and is never copied into the invocation's observed fields. No Local session identity or acknowledgement is asserted.

## Cleanup and rollback contract

Before cleanup the tool verifies the saved full pin and exact Git worktree root, enumerates changed/untracked/ignored state, and confirms the source checkout's recorded `HEAD` and status digest. On refusal it leaves both source checkout and evaluation target in place, prints the precise blocking paths, and preserves logs. If all gates pass, Git removes only the exact detached worktree, without force; the tool reads back that the target path is absent and no longer appears in `git worktree list`, then records the restoration receipt. The source checkout and log artifacts must remain byte-readable. If readback fails, stop and reconcile; do not retry under a new run ID or remove a different target.

## Meaningful local verification

From this directory run:

```bash
python3 -m unittest discover -s tests -v
```

Tests build tiny synthetic local Git repositories. They cover path containment, dirty source prestate refusal/preservation, full-pin checks, dirty target and unexpected ignored-data refusal/preservation, retained logs, exact worktree removal, and source `HEAD`/status restoration. They do not install app dependencies, test an app, use a network, or exercise a vendor service.


## Windows removal and coverage

Registration readback compares complete normalized paths from NUL-delimited Git porcelain. If Git partially deregisters a worktree and returns an error, cleanup records `completed: false`, exact target and registration state, source before/after hashes, logs and the error. It preserves residual files for owner reconciliation; it never recursively deletes an unregistered orphan. The Windows residual-removal cause still needs its actual Git error log and a fresh platform regression before an automated recovery can be accepted.

Symlink fixture tests skip only Windows privilege error 1314 and report that coverage gap. Other errors remain failures; supported Linux and Windows environments must exercise the symlink tests before full platform acceptance.
