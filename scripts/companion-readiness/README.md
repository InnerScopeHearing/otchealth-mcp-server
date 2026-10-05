# Companion readiness runner

This standalone Node script is a proposed, synthetic-only readiness check for
`InnerScopeHearing/otchealth-companion` at
`157973c73bdcef81856734cf82496760e85dc100`. It makes no branch, commit, push,
deployment, purchase, or provider request. It never bootstraps Node or pnpm.

The script is fail-closed. It requires an exact state file from the scoped
cleanup utility and a separate, unexpired execution-admission JSON file. The
admission binds the task, exact commit, current session/environment, approved
source route, and frozen dependency-install route. Without it, no Git, Node,
pnpm, or test command runs. It accepts only prepared cleanup worktrees under
`repair2/cleanup/worktrees/` and writes logs and one receipt under the matching
`repair2/cleanup/artifacts/` directory.

## Recipe after admission

First prepare an isolated pinned worktree through the cleanup utility, using
the source route that was independently admitted:

```sh
python3 repair2/cleanup/scripts/eval_worktree.py prepare \
  --repo /path/to/approved/otchealth-companion-source \
  --pin 157973c73bdcef81856734cf82496760e85dc100 \
  --run-id <unique-run-id> \
  --app companion
python3 repair2/cleanup/scripts/eval_worktree.py status --run-id <unique-run-id>
```

Create an admission file outside the checkout. It must contain these fields:

```json
{
  "schema_version": 1,
  "allowed": true,
  "scope": "companion-readiness",
  "repository": "InnerScopeHearing/otchealth-companion",
  "commit": "157973c73bdcef81856734cf82496760e85dc100",
  "task_id": "t_idem_2bde337b",
  "host_binding_verified": true,
  "task_approval_verified": true,
  "source_acquisition_approved": true,
  "dependency_install_route_approved": true,
  "synthetic_tests_only": true,
  "no_live_provider_calls": true,
  "host": {
    "session_id": "<current CODEX_SESSION_ID>",
    "environment_id": "<current CODEX_ENVIRONMENT_ID>"
  },
  "expires_at_utc": "<future ISO-8601 UTC timestamp>"
}
```

Run it from the same bound execution session:

```sh
node scripts/companion-readiness/run.mjs \
  --state repair2/cleanup/state/<unique-run-id>.json \
  --admission /path/to/admission.json
```

The runner verifies the full Git SHA, `origin` repository identity, clean
tracked/visible-untracked prestate, root package identity, `pnpm@9.0.0`,
Node `>=22`, and the two required test paths. It then runs, in order:

```sh
pnpm install --frozen-lockfile
pnpm --filter mobile exec vitest run src/boot/ErrorBoundary.test.tsx src/pages/Settings.test.tsx
pnpm --filter mobile test
```

After commands, it records numeric exits, redacted logs and hashes, UTC start
and end times, host/session/environment identifiers, exact source SHA, lockfile
before/after hashes, and visible poststate. It does not clean or reset the
checkout. If the focused tests fail, it records that numeric exit and does not
start the full suite. Retain logs and review the receipt before calling cleanup
`status`; clean the exact run through the cleanup utility only after preserving
the artifacts. The runner itself has no mechanism to approve an execution,
select a network route, or bypass cleanup ownership.

## Local synthetic tests

Run without app sources or dependency installation:

```sh
node --test scripts/companion-readiness/run.test.mjs
```

Tests inject command results and use temporary synthetic repositories. They
cover successful exact command sequencing, wrong source SHA, wrong pnpm
version, dirty prestate, missing admission, and a failing focused command with
numeric exit preservation and full-suite suppression.
