---
name: otchealth-review-process
description: Process, CI, and quality rails for OTCHealth/InnerScope repositories. Use when reviewing a pull request that adds or changes a GitHub Actions workflow, a scheduled job, a test, a bug fix, or that opens or targets a branch in this repo.
---

# OTCHealth process and quality review rails

## Branches and pull requests

- Development happens on `claude/*` branches; pull requests are opened as
  drafts. If a PR targets `main` from a differently-named branch, or the
  history shows a force-push over shared commits, flag it and ask whether
  that was intended.
- Do not treat a force-push to a shared branch as routine; it should only
  happen when the author has explicitly said so.

## GitHub Actions

- Every action reference in a workflow file must be pinned to a full
  commit SHA, with a version comment alongside it, for example
  `uses: actions/checkout@<40-char-sha> # v4.2.2`. A bare tag or branch
  reference (`@v4`, `@main`) is a blocking finding.

## Tests

- Every bug fix must ship with a regression test that fails on the old
  code and passes on the new code. A bug-fix PR with no test change is
  worth flagging.
- Never weaken, skip, loosen a threshold on, or delete an existing test
  just to make a build pass. If a PR does this without a clearly stated
  reason, treat it as a blocking finding, not a style note.

## The silent-success class

Watch for changes that can report success while doing nothing real. This
class of bug is easy to introduce and easy to miss in review, because the
code path *looks* like a normal success path:

- A scheduled job, cron handler, or CI step that exits 0 without having
  done its real work, for example because a dependency silently failed,
  a guard short-circuited before the real logic ran, or a try/catch
  swallowed the one error that mattered.
- A check, linter, or automated reviewer step whose failure path is a
  "fail-safe approve": it could not run, so it reports success or approval
  instead of reporting that it could not run.
- Any place where "the call to start or run something returned success"
  (an orchestrator's RunTask, a workflow dispatch, a scheduled trigger
  firing) is treated as proof that the underlying task actually did
  something. Those are different claims. A task can fail after the
  orchestrator's own call already succeeded, for example an image pull
  failure, a missing secret, or an early crash, and look identical to a
  healthy run from the orchestrator's point of view.

When a new job, hook, guard clause, or catch block could take this shape,
ask for an explicit test or log line that proves the real work happened,
not just that the wrapper around it returned cleanly.
