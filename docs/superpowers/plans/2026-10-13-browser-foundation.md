# Browser Foundation Implementation Plan

> For agentic workers: native execution with superpowers:executing-plans; TDD for every change. The owner approved the written architecture and waived further routine design approvals. Do not ask again for this plan.

**Goal:** Remove demonstrable reliability defects and add bounded browser interaction primitives while preserving existing safe caller/host boundaries; prepare, but do not falsely activate, general public-web access without network acceptance.

**Architecture:** Reuse the current gateway, AgentCore CDP transport and fenced job ledger. Share duration bounds, enforce a finite safe-retry limit, and extract typed CDP interaction handling into a small independently testable module. Provider network/release facts are reconciled in parallel by read-only workers.

**Tech Stack:** Existing Node24/TypeScript/tsx/node:test/zod/undici; no new runtime dependencies.

**Spec:** ../specs/2026-10-13-company-browser-platform-design.md

## Global Constraints

- Account900915535335/us-east-1; existing gross ceiling1,200USD/month. No new recurring resource, credential-value read, wildcardIAM or paid fallback.
- Preserve own caller/profile/session and protected-ring boundaries, legacy exact hosts, HTTPS/no URL credentials,20-second action bound and180-second initial session bound.
- Unknown external effects must never be automatically replayed. A passing local test is not browser/network/fleet/deployment acceptance.
- One writer/root in .worktrees/browser-platform, branchcodex/browser-platform-20261012, based on current main/deployed46714f69 plus approved architecture doc.
- General public-web activation requires pre-connection full-session private/metadata/rebinding/background containment. Missing provider proof is a real gate, not permission to addhosts["*"].

## Review Focus

1. Job180–300second mismatch: submission must reject unsupported time before persistence.
2. Repeated pre-effect failure: terminate at a finite attempt limit; duplicate terminal delivery performs no browser work.
3. Unknown/succeeded effect on retry: preserve reconciliation rather than mark safely failed or replay.
4. Malformed/out-of-bounds UI input: reject before the provider receives it; owned session/host checks still run.
5. Key/mouse/right-click/scroll behaviour: issue only known typed CDP commands; no eval or caller-chosen protocol methods.

### Task1: Duration and bounded-retry reliability

**Files:** modify src/tools/browser-cloud-gateway/index.ts, src/tools/browser-cloud-jobs/contracts.ts; tests index.test.ts and contracts.test.ts/worker tests.

**Interfaces:** consume CLOUD_BROWSER_MAX_SESSION_SECONDS. Produce exported CLOUD_BROWSER_JOB_MAX_ATTEMPTS=3; CloudBrowserJobs.claim(jobId,agent,leaseMs) keeps signature and atomically transitions a safe exhausted job to failed/retry_limit_reached before throwing job_terminal.

- [x] Write duration test: max_seconds180 accepted,181/300 rejected.
- [x] Run focused test and observe the unsupported bounds test fail.
- [x] Replace plan schema limit with the existing shared session constant; session-start remains at the same180 ceiling.
- [x] Write exhausted-claim and unknown-effect precedence tests against the real memory store/jobs.
- [x] Run and observe failures caused by missing retry ceiling; implement cap after unknown-effect reconciliation check and before incrementing claim.
- [x] Run focused gateway/job/worker suite and typecheck; record failures and commit only task files.

### Task2: Typed CDP controls

**Files:** create src/tools/browser-cloud/actions.ts/actions.test.ts; modify contract.ts,service.ts,agentcore-transport.ts and gateway action schema; test service.test.ts and gateway/index.test.ts.

**Interfaces:** export executeCloudBrowserInteraction(cdp:CloudBrowserCdp,page:string,action:CloudBrowserAction,remaining:()=>number):Promise<void>. CloudBrowserCdp.command(method:string,params:Record<string,unknown>,timeout:number,page?:string):Promise<Record<string,unknown>>. Extend actions with press_key (finite supportedkey enum), scroll (boundedcoordinates/deltas), click optionalbutton/clickCount, and mouse_move/drag (boundedcoordinates).

- [x] Add tests for exact right/doubleclick, keydown/up and scroll/drag sequences plus malformed bounds and noRuntime.evaluate/arbitrarymethod surface.
- [x] Run tests red; implement typed command dispatch and service validation while keeping current navigation/snapshot flow.
- [x] Add matching strict zod schema variants; test gateway acceptance/rejection and service ownership/host-preserving behaviour.
- [x] Run focused tests, typecheck, full npmtest and npmrunbuild; commit only verified task files. Initial integrated suite3751tests/3735pass/16skip/0fail; review corrections have43focusedgreen,typecheck/buildgreen,fullsuite rerun pending.

### Task3: Provider/release decision and continuation

**Files:** docs/cloud-browser-rollout.md and run archive; any further publicpolicy/auth/file/print implementation belongs to separately recorded bounded stages of the approved master architecture.

- [x] Read independent managed-provider/release reports; reconcile their receipts with current source and direct tools.
- [x] Record exact unsupported feature/network/credential/device/release gates. Add a capability matrix that distinguishes authored, tested and live accepted.
- [ ] Obtain a fresh whole-branch reviewer where available; do not silently replace requestedSolreviewer withLuna or claim an unavailable review passed.
- [ ] Use verified existing release workflow only after source/tests/network/rollback acceptance; never deploy an untested or permissive workaround.
- [ ] Continue subsequent authorized stages when a concrete safe action exists. Stop only affected lanes for real provider/security constraints and preserve tested commits.

## Scope coverage

This plan deliberately implements the first master-spec release, not all files/credentials/printing/fleet features. These remain visible incomplete packages. Physical printer binding, saved real account credentials, provider network enforcement and per-seat UI acceptance cannot be invented. The owner's full mission remains the overall definition of completion.
