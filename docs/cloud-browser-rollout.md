# Cloud browser rollout and acceptance

The gateway provides authenticated MCP actions backed by AWS browser sessions. It does not start a second language model. DynamoDB stores owner-bound session/job state, SQS dispatches deterministic jobs, and S3 retains versioned result artifacts. The existing ECS gateway polls the queue, so the operator's laptop is not required for job execution.

## Deployment inputs

- `CLOUD_BROWSER_ENABLED=true`
- `CLOUD_BROWSER_WORKER_ENABLED=true`
- `CLOUD_BROWSER_DDB_TABLE=otchealth-browser-cloud`
- `CLOUD_BROWSER_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/900915535335/otchealth-browser-cloud`
- `CLOUD_BROWSER_ARTIFACT_BUCKET=otchealth-chat-agents-900915535335-us-east-1`
- `AWS_REGION=us-east-1`

The table has a string partition key `pk` with no sort key, on-demand capacity, encryption, and TTL on `expiresAtEpoch`. The standard queue uses managed encryption and 120-second visibility. Application leases and idempotency handle duplicate delivery. The existing artifact bucket must have versioning enabled. Runtime permissions are recorded in `infra/aws/browser-cloud-runtime-policy.json`; DynamoDB transaction authorization uses the component item permissions, not an invented TransactWriteItems IAM action.

No credentials are included in these files. ECS obtains temporary AWS credentials from its task role. Saved website cookies remain in AgentCore browser profiles. Browser observations and artifacts can contain sensitive page data and require the same agent ownership checks as the source session.

## Candidate acceptance before gateway activation

Build the candidate image from the exact reviewed commit. Run `node dist/server/cloud-browser-acceptance.js` in a one-off ECS task with the gateway task role and the configuration above, before changing the live service. It verifies public navigation, page content, cross-owner denial, profile save, durable queue execution, idempotency, and a versioned artifact. The test logs boolean receipts and opaque job IDs, not page contents or credentials.

The pre-provisioned acceptance profile is `cto-public-trial`, owned by `cto`, with example.com, www.example.com and docs.aws.amazon.com as allowed hosts. It is not a website login or enrollment for another agent.

After acceptance, release through the standard build workflow and ECS revision update, retain the prior image/revision, wait for stable tasks, verify health and catalog from both replicas, and repeat the public test through the live MCP client.

## Per-agent readiness

Each agent requires its own owned profile and a test from its actual Chat or other supported MCP connection. Seeing tools in a catalog is not evidence of browser access. A passing root or task-role test is not evidence of Chat client acceptance. Human sign-in and any website challenges must use the provider's supported interactive session.

The legacy `browser_cloud_profile_provision_public_trial` flow remains available to the CTO for the seven existing eligible lanes (`cto`, `cfo`, `clo`, `coo`, `cro`, `developer`, and `wefunder-campaign-director`). It creates the deterministic non-persistent `<lane>-public-trial` profile restricted to the exact reviewed host list. The receiving lane uses `browser_cloud_profile_discover`; discovery never lists another owner's profile. `clo-personal` remains excluded.

The separate `public_web` mode is for root-enrolled profiles only. The authenticated caller can use `browser_cloud_public_web_profile_discover` to discover its own profile, but there is no caller-facing enrollment or profile-conversion path. Enrollment must be performed by the root/operator in the trusted profile store for an already eligible owner; it must include the custom browser identifier and verified server-side network-policy configuration. This mode accepts HTTP and HTTPS URLs for public domains without per-domain host enrollment or arbitrary per-site click/time/daily-session caps. The profile's action/session/mission budgets remain server-configured, and the provider's documented maximum session timeout is 28,800 seconds (8 hours); that is a provider ceiling, not an application promise of unlimited access or unlimited provider cost. The legacy host-profile limits below remain unchanged.

Private-address, DNS-rebinding, redirect, and background-request containment is enforced by the isolated browser proxy/VPC network policy, not by gateway URL parsing or the pre/post-navigation URL checks. Do not activate/enroll a public-web profile unless its server-controlled network-policy marker and proxy configuration have been verified against the deployed containment controls. A successful navigation alone is not proof of that boundary.

Acceptance requires: discover tools, start owned session, navigate, read, perform an authorized reversible edit, verify saved state, retrieve a job artifact, reconnect and retrieve the result again, and confirm another seat cannot use the session or artifact. Do not mark a seat ready until these receipts exist.

## Limits and remaining scope

The browser foundation adds typed right-click, double-click, keyboard/shortcut, scroll, pointer-move and bounded drag operations to navigate/click/type/wait/observation. These are source capabilities, not proof of live provider or client support. It is not yet full desktop control. File upload/download, image screenshots, a user-facing sign-in/live-view flow, broader background plans, and Daytona transport require separate implementation and acceptance. The existing Daytona Linux desktop trial does not prove Chat MCP integration. No 64 GiB Windows desktop or vendor capacity request is part of this rollout.

Legacy host-profile runtime limits are 180 seconds per session, 20 actions and 10 sessions per owner per UTC day. Those pilot limits do not apply to accepted `public_web` profiles, which use their root-configured mission/action budgets and provider timeout ceiling instead. Neither mode has an account-wide dollar cap; monitor actual gross AWS usage and retain operational controls to stop new dispatch, reconcile active sessions, and restore the prior ECS task definition if acceptance fails.

Trial budget note: the ten daily session slots count start attempts, including provider failures. Reservation occurs before the provider call so concurrent attempts cannot bypass the cost bound. This is an attempt limit, not a guarantee of ten successful sessions. Durable job errors after possible external effects are recorded as needs_reconciliation before queue acknowledgement; pre-effect expiry retains its delivery for retry.

## Foundation candidate — 2026-10-13

Job submission now shares the 180-second session ceiling. A job may be claimed at most three times. An exhausted pre-effect job is terminally failed and its duplicate queue delivery performs no browser work; unknown or already-succeeded effects retain reconciliation status rather than becoming replayable failures.

Interaction input uses a strict typed schema, with finite key names, modifier bounds, bounded coordinates/deltas and at most 20 drag steps. Callers cannot supply JavaScript or arbitrary CDP methods. Each double-click emits the initial click and then the second click; Enter/printable keys include text unless a command modifier suppresses it. A single cleanup attempt releases held input even after a lost acknowledgement or expired action deadline, is capped at one second, and preserves any primary failure. A failed drag releases at its last attempted position, not automatically at the intended destination. Cleanup is not proof that an uncertain external effect did not occur.

| Capability | Source / local verification | Candidate live acceptance |
|---|---|---|
| Duration consistency; finite retry ceiling | Implemented; gateway/job/worker regression tests | Pending immutable-image and ECS acceptance |
| Right/double click; keyboard; scroll; move; drag | Implemented; typed input and failure-cleanup tests | Pending AgentCore and each actual client |
| Exact HTTPS host and session-owner checks | Preserved for legacy profiles; public-web profiles also retain session-owner checks | Existing example-only trial is not broad-web proof |
| HTTP/HTTPS public-web navigation | Public mode accepts both schemes without per-domain host enrollment; legacy profiles retain exact host policy | Requires a root-enrolled profile and verified isolated-egress policy |
| Saved account credentials / sign-in UI | Existing opaque profile references only; no credential broker or enrollment | Pending authorized account binding and reconnect tests |
| Tabs; screenshots; upload/download; PDF/export | Not implemented in this foundation | Pending implementation and synthetic acceptance |
| Physical printing | Not implemented | Pending actual printer binding and output receipt |
| All-agent distribution / recovery | Not established by this candidate | Pending independent same-seat/client receipts |

Do not replace legacy exact host lists with a wildcard. Public-web mode intentionally has no per-domain allowlist; its containment boundary is the verified isolated-egress proxy/VPC policy. Full-session enforcement must block private IPv4/IPv6, loopback, link-local/metadata and rebinding destinations before connections, including redirects, background requests and new tabs. Provider metadata and post-navigation URL checks do not establish this boundary. Monitor cost; neither the public-mode provider timeout nor its configured mission budgets are an account-wide dollar cap.

The existing ECS task definition and pinned image digest must be captured immediately before any release and retained as rollback targets. At the read-only preflight the queue had no redrive policy; an empty approximate queue does not prove pending outbox dispatch is empty. Reconcile those recovery facts independently, and do not treat local build or PR CI as deployment.

