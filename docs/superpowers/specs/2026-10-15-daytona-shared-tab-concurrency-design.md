# Shared company-browser V2 concurrency

## Intent and limits

The user chose one persistent company Chromium profile shared by seven company agents and wants overlapping browser work without agents operating each other's tabs. Agent computation and page loading may overlap; complete browser actions are briefly serialized. Shared cookies, storage, website accounts and application-side writes remain shared, so this does not promise collision-free business transactions or separate security contexts.

Use the existing private sandbox, encrypted keyring supervisor and OAuth/principal bindings. Do not create resources, clone profiles, export cookies/passwords, relax network gates or modify the currently pinned live upgrader. This is a separate inactive V2 candidate until real-browser acceptance passes.

## Ownership and action coordinator

Retain one physical Chromium/profile supervisor and its process-lifetime OS locks. Keep each virtual principal's durable mission lease. Omit the whole-mission DISPLAY lease only for a new mission after fresh exact-profile runtime proof `{runtimeProtocol: 2, multiMissionReady: true}`. Persist that choice on the mission so replicas never infer protocol from process memory. V1 behavior stays unchanged.

V2 replaces the single local `mission.json` with a private fsynced registry of at most seven exact session/principal entries. Each new mission receives a newly created blank target, never an existing agent's page. Target ownership and selected target are per mission. A single local mutex covers open, one complete action, transfer promotion, release and global barrier transitions. Waiting is bounded by the existing absolute deadline. Every action is target-scoped; input and focus changes remain inside the mutex. Browser protocol failure after an effect leaves a durable global unknown fence, never an automatic timeout release or replay.

The first candidate bounds the registry to 28 total owned tabs and four tabs per mission. Popup targets are not silently adopted. Following the approved clipboard refinement, Ctrl/Meta+C/V use a separate private text buffer per mission (64KiB UTF8 each, private0600 registry bounded1MiB), fixed isolated-world native DOM selection and target-scoped native text insertion; no OS clipboard is read or written and copied text is never returned in action receipts. Buffers disappear on mission stop. Unsupported modifier combinations and print/save/find accelerators return explicit capability errors; human OS clipboard remains available during exclusive takeover. Download controls are not advertised as concurrent functionality until download GUID ownership is implemented. Uploads continue to use native target-scoped file inputs and the existing malware-cleared byte broker.

## Human takeover and checkpoint

A new fixed `human_pause` operation, under the same local mutex, requires the issuer to be the only active mission and durably sets a global HUMAN barrier before minting any viewer. No other mission may open, act, read or promote uploads while paused. Only the exact issuing session/principal may resume, and the trusted service does so only after confirmed provider token revocation and native zero-client proof. Unknown mint/revoke effects retain the pause permanently.

Checkpoint requires sole mission ownership and the same global barrier. The existing verified `Browser.close`/exact-PID-exit/reopen sequence remains real; it cannot run while another mission owns working tabs. Done revokes human input, checkpoints, then clears the barrier; it never labels a deferred/no-op checkpoint saved. Normal mission stop affects only its own targets and registry entry, never another agent's targets or the retained desktop. Unknown effects remain fenced for operator reconciliation.

## Composition

Add a distinct `daytona-company` automation alias whose start does not issue a human viewer. Preserve `daytona-desktop` as the human onboarding alias. Fleet-owned contract/client changes carry optional mission protocol and exact-bound proof plus fixed pause/resume operations; gateway/runtime work belongs to the viewer worker. Registry/dispatcher/checkpoint/service changes are isolated here; transfer-stage adapts to the same registry under the same mutex.

## Acceptance

Tests first: two principals can hold overlapping missions; each starts with a different target; concurrent input/click/navigation operates only its owned page; cross-principal tab IDs fail before effects; stopping one preserves the other; global human pause blocks all automation; checkpoint is rejected without closing Chromium while another mission is active; unknown action or pause persists across a new dispatcher process; pre-effect busy does not strand a principal lease. Run an actual sandboxed local Chromium with two distinct synthetic fixture pages and concurrent subprocess dispatch calls, verify exact native field values/click counters and surviving target IDs. No mock-only concurrency or password-persistence claim.
