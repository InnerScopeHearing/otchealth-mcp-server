# Company-agent browser platform

Date: 2026-10-13. Owner: root. Run: OTC-FULL-BROWSER-20261013-0538. Status: written architecture for owner review; NOT implemented, installed fleet-wide, or deployed.

## 1. Owner intent and definition of completion

Replace the restrictive, fragile pilot with a dependable browser platform shared by company agents. An agent should be able to accept an authorized mission, browse ordinary public websites without per-domain enrollment, use protected saved sign-ins, manipulate the full browser UI, transfer files, generate PDFs/export, and recover from interruptions without abandoning work or blindly repeating external effects.

Requested capabilities include full keyboard/mouse controls, right-click, double-click, drag/drop, scroll, tabs/windows, dialogs, screenshots/live view, uploads/downloads, PDF/export/virtual print and physical printing. This is an architectural program with distinct policy/recovery, interaction/files, credentials and fleet/device integration subprojects; a public-web fix alone is NOT completion of the full mission. Their interfaces and release acceptance are specified below. Detailed implementation plans follow written review, beginning with the existing-browser policy/recovery foundation.

The owner approved the general-public-web direction and explicitly requested saved usernames/passwords and end-to-end deployment. These are requirements, not proof that account credentials, printer bindings, every agent installation, network containment or deployment prerequisites already exist. Mission-scoped routine work should not require repetitive approval prompts. New financial/account-security/destructive authority, protected data access, provider approval requests and site-imposed identity challenges remain distinct boundaries.

Success is a capability-by-seat evidence matrix, accepted failure/recovery tests, exact release provenance and rollback proof. Do not promise permanent uptime, exactly-once arbitrary website effects, challenge bypass or universal unattended site access. No claim of 100% completion is permitted while a requested capability is missing/unverified. An unbound physical printer is a visible incomplete feature, not something PDF output conceals.

## 2. Verified baseline and source pin

The existing account is 900915535335 in us-east-1. Prior actual Core reads observed ECS cluster otchealth, service otchealth-gateway, desired 2/running 2, completed deployment, task definition 208, and two healthy ALB targets. Image digest was sha256:d7b912bb90b4e91977887359adfc0728e15aa3450599259b095d771f4cef760d with source pin 46714f69f00b89a5d418a6101128d1431da95255. Reconcile fresh prestate immediately before a release; these observations are not authorization to deploy an unreviewed image.

The local checkout is 36e2459b1959c5bef6136a8fe12f9ec09c33c25a, 24 commits behind the deployed source pin. Core browser-cloud service/store/jobs/runtime blob identities match the deployed pin, but broker enrollment and release workflow differ. Root independently read pinned enrollment blob 4db12a5aebe1ec317a8a57703613264ad83d037e: Developer has public_read only for docs.aws.amazon.com, docs.github.com, developers.openai.com and example.com. Public-trial cloud profile discovery separately returned example.com/www.example.com and persistent false. Both restrictions must be replaced coherently; editing one layer leaves the other blocked.

Actual native Developer start/navigation/snapshot/stop on example.com succeeded. Subsequent exact-session read was unavailable. Only navigation, bounded observation and cleanup were exercised; source support for click/type/wait is not a live acceptance receipt. A later Framer/OTChealth broker preflight batch refused target_not_enrolled before session creation. No full-browser feature, authenticated Framer editor, durable recovery or other-seat success follows from this smoke.

Current local sessions cap 180 seconds, 20 actions and 10 start attempts per owner/day. Job validation accepts 300 seconds despite the 180-second service cap. Jobs have DynamoDB leases/fencing, SQS delivery and immutable versioned S3 artifacts, but no demonstrated periodic outbox recovery, bounded retry ceiling, orphan janitor or exposed effect-reconciliation path. AWS docs describe longer sessions, persistent profiles, CDP/Playwright, InvokeBrowser OS actions and file mounts; documentation is not application implementation or account acceptance.

Research/receipt archive: /workspace/full-browser-platform-2026-10-13 and the prior /workspace/browser-reliability-2026-10-13. No customer bodies, secret values, signed endpoints or private logs belong in this specification.

## 3. Recommended architecture and alternatives

Reuse the existing authenticated Fastify/MCP gateway, managed AgentCore browser and DynamoDB/SQS/S3 job/artifact plane. Add versioned policy and capabilities, richer typed worker adapters, persistent-profile/credential bindings, file-transfer handling and bounded recovery. Preserve existing caller binding, role/ring separation, Brain/source stores and release ownership.

Alternative: a custom browser with controlled egress is appropriate only if the managed provider cannot prove the required full-session network boundary. It needs its own exact resource/IAM/cost/rollback approval and cannot silently become a more expensive fallback. An always-on remote Windows desktop is unnecessary for ordinary browser controls and is not the same as controlling the owner's Windows ChatGPT app; introduce a supported device bridge only for capabilities that actually require local hardware/native applications. Growing a finite domain list or settinghosts["*"] does not satisfy the mission.

| Component | Responsibility and public contract | Boundary |
| --- | --- | --- |
| Gateway/capability registry | Authenticated caller, capability discovery, mission submission, own job/session/artifact status | No raw browser endpoint, arbitrary CDP/JavaScript, secret values or impersonation |
| Destination policy | Versioned enrolled_hosts legacy mode and public_web mode; one consistent broker/session/job interpretation | Missing legacy version retains exact-host behavior; unknown versions fail closed |
| Browser worker adapters | Typed CDP/Playwright browser actions and typed InvokeBrowser OS actions | Browser capability is distinct from authorization for a mission's effects |
| Profile/credential broker | Owner/site/account binding, secret reference resolution inside isolated runtime, provider-backed persistent state | No model-visible plaintext or cross-agent cookie reuse |
| File/artifact broker | Staging/quarantine, mounted browser files, downloads/uploads/PDF/export with receipt/hash/access/retention | Agent-scoped paths; no arbitrary bucket/local paths or executable downloaded code |
| Durable scheduler/recovery | Fenced jobs, outbox dispatch, retries/backoff, effect state, janitor and cancellation | Unknown external effects are reconciled, never blindly replayed |
| Fleet/device integration | Tool/skill versions, same-seat acceptance; explicitly bound printers where required | Publication or one successful seat is not fleet installation |

## 4. Public-web and mission policy

Public-web profiles allow ordinary public HTTPS destinations without individual domain approvals. Preserve HTTPS initially; HTTP-only sites are explicitly unsupported in the initial foundation and must not be advertised as complete public-web coverage. Full-platform completion also requires an explicitly accepted public HTTP read mode on port 80, under the same connection-level private-address boundary; never automatically downgrade an authenticated task or transmit credentials over HTTP. Public-to-public login/CDN redirects are allowed under the general mode. Exact origins still bind credentials to the intended account/login form, not to whichever site requested them.

Block URL-embedded credentials, private/reserved/loopback/link-local/metadata destinations and unauthorized local protocols. Enforce the policy at the remote browser's actual connection boundary throughout the session, including DNS changes, redirect chains, subresources, scripts, workers, popups, WebSockets and traffic between actions. Gateway DNS checks are defense in depth only. Post-navigation checks and action-scoped CDP interception are insufficient because current CDP streams close after each action and the browser remains active.

The managed provider's full public-only egress/DNS-rebinding/local endpoint protections remain unverified. This is a release-blocking acceptance requirement, not a placeholder implementation choice. If a supported provider-wide boundary cannot pass controlled tests, public_web activation remains disabled and a separately costed isolated egress design is required. No wildcard IAM or browser access to task-role credentials is an acceptable shortcut.

Every job carries a versioned mission manifest: caller/owner, allowed action classes, credential/profile references, time/action/concurrency/file budgets, relevant destination exclusions and permitted external effects. Browser text is untrusted data and cannot expand that manifest. Routine interactions and transfers necessary for an authorized mission proceed within it without repeated prompts. An unrelated payment, destructive account operation, security downgrade, protected-data transfer or new authority pauses only that affected work; independent safe work continues.

## 5. Full interaction and file capabilities

Add typed actions for keyboard press/chords/text, mouse move/left/right/double click/drag, scroll, element focus/select, tab/window create/select/close, back/forward/reload, waits/reads/screenshots, dialog handling and provider OS actions. Each action identifies its session/tab, validates bounds and deadline, and returns a bounded receipt or own artifact reference. No unrestricted eval/CDP method or operating-system command enters the model tool contract. Clipboard/OS dialogs follow the same sensitive-output rules.

Implement files through a per-owner transfer broker and the provider's supported EFS/S3Files mount configuration or another explicitly verified provider mechanism. Staged uploads are owned immutable file references, not caller-chosen filesystem paths. Enforce size/MIME/path limits, antivirus/quarantine status, denied executable/archive policies where appropriate, object integrity hashes, retention and access restrictions. Downloads survive browser interruption as durable authorized artifacts with a completion/partial state; partial files never pass as complete. Website uploads are mission effects and need post-upload state verification; a timeout does not justify uploading again.

PDF generation/virtual printing should use an accepted provider-supported browser PDF path or verified print-to-file flow. Return a durable PDF artifact and validate magic bytes, page count and content fixture. General export uses the site's authorized export/download flow, not a fabricated report. A physical print action needs an exact printer/queue identity, authenticated bridge, copy/page limits and queue receipt. No printer is currently bound; physical printing remains incomplete until setup and actual synthetic print acceptance. The current Linux runtime cannot control the user's Windows app or local printer merely because full computer access was stated.

## 6. Protected saved sign-ins

Saved usernames/passwords are held in a governed secret vault using opaque dynamic references; they are not stored in prompts, code, mission text, queues, logs, screenshots, PDFs, model-visible responses or Brain. Root/model tools must never call GetSecretValue/BatchGetSecretValue or fetch a local secret daemon. Runtime resolution uses an approved wrapper/broker; the isolated worker receives only the exact mission-bound credential and injects it into the verified origin's login form without returning values.

The new injection adapter needs exact per-secret IAM/KMS scope, owner/origin/account matching and a non-sensitive enrollment UI. Current checked-in runtime policy does not evidence this grant; it does not establish that the deployed role lacks or has it. Effective runtime authorization must be independently read and reviewed. Never expand a generic gateway model role into a universal secret-reading principal.

Treat persistent cookies/storage as credentials. Use distinct provider-backed profiles per owner/account with fenced single-writer leases, verified encryption/access/retention, revocation, profile save/restore and recovery semantics. Login forms, recording and sensitive screenshots must be suppressed/redacted during injection; provider profile protection alone cannot prevent rendered-page leakage. Existing non-persistent public profiles remain valid and do not silently gain account access.

MFA, CAPTCHA, passkeys, initial consent or provider-required identity verification can require a legitimate human handoff. Supply an authenticated, short-lived live-view/challenge path and preserve resumable job state. Do not bypass security challenges, disable MFA or copy an owner's unrelated browser cookies. Password rotation and session revocation are separately verified; rotating a password does not prove old cookies were invalidated.

## 7. Reliable unattended recovery

Durably record submission before queue delivery, with an indexed pending outbox and an idempotent redispatch process. Do not scan an entire company table. Match plan/session time limits at submission; start with the existing bound for the foundation, then increase only with provider/cost acceptance and checkpointed continuation. Long missions use safe resumable steps rather than assuming an immortal session. The daily start/action limits must become explicit mission budgeting, not silent churn or an unlimited grant.

Define retry classes, exponential backoff, max attempts, an exact redrive/quarantine path and observable next decision. Pre-effect failures can retry within budget. Every potentially non-idempotent step records intent and unknown-effect state before execution; lost acknowledgement, expired lease or stale worker does not prove the effect did not happen. The outbox/lease reconciler checks the effect journal before redispatch; it never blindly re-enqueues a job with an unknown website effect.

Expose owner-scoped status and audited evidence-based effect reconciliation. Add provider-session cleanup on completion/cancel/shutdown and a bounded janitor for expired/orphaned sessions. DynamoDB TTL deletion is not provider stop. Preserve hard provider TTL as a backstop. Test crash after provider start, before session persistence, during action, before artifact publication and after success before SQS acknowledgement.

Install an actual supervisor/health path and alarms for queue age, dispatch pending age, retry exhaustion, lease expiration, provider auth/stream failure, cleanup failure and needs_reconciliation. Capability status distinguishes provider down, client unbound, permission denied, auth challenge and feature unsupported; agents should not report all of these as browser down. Recovery preserves the same durable mission handle. No installed watchdog or alarm is claimed by this document.

## 8. Fleet distribution and scopes

Initial company gateway owners are cto, cfo, clo, coo, cro, developer and wefunder-campaign-director. Verify actual available identities and add other requested company workers through the supported owner-aware mechanism; this enumerated foundation is not a claim that every future/app/Hyperagent seat is enrolled. Protected personal/legal/PHI lanes remain isolated and require their own authorized runtime, not a company-browser grant.

Publish a versioned browser-operator skill and expose the same supported typed capabilities through each intended Chat/Work/Codex/cloud client. The skill states routing, saved-auth references, file/PDF procedures, mission bounds, recovery, exact denied/error semantics and when to use live-view. Installed release IDs/hashes and client refresh/load receipts are required. Publication, local files, native catalog presence and another seat's test do not establish successful installation/invocation.

For each intended owner and surface, record profile/policy/capability versions; own-seat discovery; public navigation across unrelated hosts; required interaction/files/login/PDF/device tests; restart/reconnect recovery; wrong-seat session/artifact/credential denial; cleanup. A missing client binding remains blocked, not an invitation to use another identity. The existing Edge connector 429/404 failures remain exhausted at 2/2 attempts; AWS managed browsing is independently verified and becomes the default supported route after acceptance, not a replay of those failures.

## 9. AWS DevOps coordination and cost

Root connected to the existing AWS DevOps Agent space 18a3ece9-2bd4-450f-8cfd-b89c27247601 (DevOpsAgentSpace), created execution 88656c81-7f55-4aee-b59a-f172479b8d4f, sent one source-free read-only review request and received completed response resp_f2fcc9703ad84b5aa331d4fd87958cfa. Independent ListJournalRecords retrieved final_response record 62334208-6a7f-417c-9dcb-1b260c92a65e. The consultation made no infrastructure changes, and is not a release/deployment receipt.

Its useful recommendations were bounded attempts, pending-job recovery, orphan cleanup and reconciliation visibility. Root corrects advisory limitations: safe recovery cannot re-enqueue unknown effects; schema/logic timeout corrections are not necessarily config-only; provider docs allow longer sessions but current application acceptance does not; only the actual navigate/observation/stop smoke is verified. Agent advice is independently evaluated, not copied as operational fact.

Current gross ceiling is 1,200 USD/month, excluding credits/refunds, with separate OpenAI API spend. Actual Cost Explorer reads on October 13 observed MTD 392.6624577284 USD through October 12, estimated; daily remaining forecast 594.552506138708161 USD gives projected 987.214963867108161 USD and estimated headroom 212.785036132891839 USD. A monthly forecast bucket initially included the entire month; daily-period read reconciled it rather than double counting MTD. Headroom is estimated, not a guarantee or new spending authorization.

Current DevOps Agent price is 0.0083 USD per cumulative active agent-second; idle time is not charged, and no credit assumed. The single consultation completed; exact billed agent-time was not returned. Do not infer cost from wall time or token count. No new recurring browser/firewall/desktop capacity was bought. Each release/subproject proposal must provide exact resource/IAM/region/cost and rollback within the ceiling; an always-on firewall/desktop fleet cannot be added on speculation. Reuse managed browser/pay-on-use and existing worker capacity where accepted. If adequate security or full features cannot fit, present the exact costed alternative and require a budget decision rather than silently increasing the ceiling.

## 10. Acceptance, release and rollback

| Release package | Required evidence before acceptance |
| --- | --- |
| Policy/recovery foundation | Coherent broker/profile/job public mode; legacy compatibility; pre-connection private/metadata/rebinding/background denial; unrelated public sites/redirects; consistent limits; bounded retry/outbox/fencing/cancel/cleanup; exact own-client result |
| Interaction/file/PDF | Every typed input/tab/dialog/screenshot action; safe mounts and owner paths; real upload/download/export and complete artifacts; valid PDF/virtual print; restart during transfer; bounds/quarantine and cross-owner denial |
| Saved-auth/profile | Synthetic secret-only runtime injection; zero plaintext/cookie leakage through model/logs/artifacts; persistent save/reopen; rotation/revocation; legitimate challenge resume; wrong owner/origin denied |
| Fleet/device completion | Versioned skill installed/loaded/invoked from every scoped surface; actual per-seat capability receipts; full mission and recovery exercise; exact physical printer queue/job receipt if physical printing is required |

All tests use controlled synthetic pages/data/accounts/files, not customer records or account mutations. Containment tests must prove denial before connection, not a later refused observation. Include mixed DNS answers and rebinding, redirects, direct/private IPv4/IPv6, workers/popups/subresources/WebSockets, duplicate SQS delivery, crash before/after effect, lease/visibility failures and cancellation with an unknown effect. Evidence retains safe booleans, timestamps, opaqueIDs and hashes, not secrets or private content.

Release source must be pinned to the reviewed current branch and verified CI. The pinned ECR workflow builds/tests/pushes but explicitly does not deploy; it uses OIDC, not static-key fallback. Record candidate commit/image index and child digests, exact runtime configuration/taskrole, compatible data policy and real browser acceptance. A separately authorized operator deploys by digest to the exact ECS service after recording current image/task/config/profile prestate. ECS stability/health/catalog are necessary but not browser acceptance.

On failure stop new dispatch safely, preserve pending/running/unknown work and provider sessions, restore the recorded compatible prior image/task/config/policies and read back behavior. Additive versioned ledger fields must remain old-reader compatible or quarantine unsupported jobs; a simple image rollback is not enough if state is incompatible. Never purge user state, erase profiles or replay unknown effects. Synthetic rollback/recovery evidence is required before broad activation.

## 11. Review and next gate

This document records the full mission and modular design. It has no implementation scaffolding, new dependencies, profile grants, credential values or deployment changes. Owner review of this written architecture is required by the brainstorming workflow before a detailed foundation implementation plan/execution selection. Later packages retain the same full-mission completion criteria and their exact resource/credential/device prerequisites.

Review focus: ordinary public HTTPS first; existing managed AWS runtime with verified egress; protected saved sign-ins; full interaction/file/PDF stack; recovery without blind effects; per-agent acceptance; physical-printer binding; cost within the existing ceiling. Missing network proof or a printer binding is a concrete gate, not a promise to deliver hidden defaults.

## Source links

- [Pinned deployed broker policy](https://github.com/InnerScopeHearing/otchealth-mcp-server/blob/46714f69f00b89a5d418a6101128d1431da95255/src/tools/browser-broker/enrollment.ts)
- [AgentCore Browser](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html), [OS actions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-invoke.html), [profiles](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-profiles.html), [filesystems](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-filesystem-configurations.html), [quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)
- [DevOps Agent SendMessage](https://docs.aws.amazon.com/botocore/latest/reference/services/devops-agent/client/send_message.html), [pricing](https://aws.amazon.com/devops-agent/pricing/)
