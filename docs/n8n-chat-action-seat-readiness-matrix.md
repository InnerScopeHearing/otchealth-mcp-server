# n8n Chat action seat readiness matrix

Audit scope: repository implementation only, read on 2026-09-22. No n8n instance, credentials, gateway deployment, or live seat state was inspected. `Ready` below means the repository contract is present, not that live acceptance has passed.

## Current contract

The common bridge exposes exactly two actions, `brain_search` and `checkpoint`, through three HMAC-signed webhooks: submit, status, and result. Jobs are opaque, caller-bound, and idempotent. n8n stores the durable job record and invokes gateway internal job routes using the existing `OTCHealth Gateway Service` credential. The gateway rejects `clo-personal` recursively before persistence or execution.

The implementation has two separate company-lane allowlists. The n8n submit workflow and gateway job/executor currently allow `cto`, `developer`, `coo`, `cro`, `cfo`, `clo`, and `exec`. The dedicated WeFunder identity is `wefunder-campaign-director`, so it is rejected by the current submit workflow and gateway executor. `exec` is accepted by the code but is outside this audit's requested seat matrix.

## Per-seat readiness

| Seat | Caller identity expected | Repository readiness | Common through n8n | Seat/vendor-specific boundary | Live acceptance required |
|---|---|---|---|---|---|
| CTO | `cto` | Contract-ready, live unverified | Same three workflows, HMAC, opaque job lifecycle, Brain/checkpoint executor | CTO identity and its gateway authorization; no credential values in exports | Prove identity, submit/status/result, idempotent replay, invalid HMAC 401, and caller binding with a synthetic company query |
| CFO | `cfo` | Contract-ready, live unverified | Same | CFO lane scope and Brain authorization remain gateway-owned; n8n must not select a lane from request text | Repeat the CTO suite using the CFO principal and confirm the returned Brain result is CFO-authorized; attempt a foreign-lane request and verify refusal |
| CLO corporate | `clo` | Contract-ready, live unverified | Same | Corporate legal scope is distinct from `clo-personal`; n8n cannot be the policy authority | Repeat the suite as `clo`; test corporate legal request if supported by Brain policy; submit nested `agent`, `scope`, and `room` values of `clo-personal` and verify refusal before persistence |
| COO | `coo` | Contract-ready, live unverified | Same | COO mailbox and operational permissions remain gateway/vendor-specific and are not added by this bridge | Repeat the suite as `coo`; verify checkpoint persistence and a synthetic operational Brain read; confirm status cannot be read with another caller hash |
| CRO | `cro` | Contract-ready, live unverified | Same | Revenue systems and CRO permissions remain gateway/vendor-specific; no Shopify or campaign capability is granted by this bridge | Repeat the suite as `cro`; verify only the two allowlisted actions are accepted and an unsupported action is rejected |
| Developer | `developer` | Contract-ready, live unverified | Same | Developer repository/tool permissions remain gateway-specific; n8n is only the durable action seam | Repeat the suite as `developer`; verify caller-bound status/result and that no arbitrary webhook or n8n API operation is exposed |
| WeFunder | `wefunder-campaign-director` | **Blocked by current code** | No current path through these workflows | Dedicated principal and source entitlement must remain separate from CRO; adding it requires an explicit code and policy change, then review and deployment | First establish an approved allowlist change. Until then, prove the negative: submit is rejected by n8n/gateway and no job is persisted. After an approved change, run the full positive and negative suite with the actual WeFunder principal, exact source binding, and no borrowed credential |

## What is common

The following can be shared across the six currently accepted company identities (`cto`, `cfo`, `clo`, `coo`, `cro`, `developer`): the three workflow JSON exports, webhook paths, HMAC envelope, `OTCHealth Gateway Service` credential name, `N8N_GATEWAY_BASE_URL` and `N8N_WEBHOOK_SECRET` environment-variable names, opaque job IDs, idempotency behavior, status/result projection, and service-authenticated internal gateway routes. Workflow exports must remain secret-free and inactive until acceptance passes.

## What must remain seat or vendor specific

- The authenticated caller identity and caller hash. n8n must forward the identity established by the gateway and never infer it from a user-supplied request.
- Brain scope, checkpoint authorization, and personal-legal exclusion. `clo-personal` is prohibited even when nested in `agent`, `scope`, or `room`.
- WeFunder's dedicated principal and exact source entitlement. It does not inherit CRO access and is not accepted by the current bridge.
- The gateway service credential and both n8n environment values. Their names are part of the contract; values belong only in protected runtime configuration.
- Any provider-specific action such as mailbox, revenue, repository, campaign, or source-agent access. The current bridge grants only `brain_search` and `checkpoint`.

## Exact live acceptance sequence

Run this sequence separately for each accepted seat using its actual principal, synthetic non-sensitive request data, and a fresh correlation ID. Do not use a borrowed credential or live customer, legal, financial, health, or personal data.

1. Confirm the three imported workflows are present, inactive before testing, and bound to the existing `OTCHealth Gateway Service` credential. Confirm `N8N_GATEWAY_BASE_URL` and `N8N_WEBHOOK_SECRET` are configured in n8n without exposing values.
2. Send a deliberately invalid signature to each webhook. Each must return HTTP 401 and create no job.
3. Send a valid synthetic `brain_search` submit with a stable idempotency key and the actual seat caller identity. Expect an opaque `caj_` job ID and `queued` or `running` status.
4. Resubmit the exact same payload and key. Expect the same job ID and no second durable job.
5. Read status with the original caller hash. Expect only the state envelope. Read status with a different synthetic caller hash and expect not-found or equivalent denial.
6. Read result after terminal state. Expect the bounded result or bounded error, with no secret, PHI, personal-legal content, or arbitrary n8n data.
7. Repeat with synthetic `checkpoint` input and verify the checkpoint adapter receives the original caller identity.
8. Submit a request containing `clo-personal` at top level and nested under `agent`, `scope`, and `room`. Expect refusal before persistence or execution.
9. Submit an unsupported action and malformed idempotency key. Expect validation refusal and no job.
10. Confirm the n8n execution record and gateway logs contain correlation and hashed caller metadata only, then activate the workflows after all checks pass.

For WeFunder, perform only steps 1, 2, 8, and 9 against the current code to document the expected refusal. Do not claim positive readiness until the dedicated principal is explicitly added to all relevant policy gates and the resulting change is deployed and tested.

## Evidence inspected

- `src/n8n/chat-action-client.ts`: action set, webhook paths, recursive personal-legal rejection, caller forwarding.
- `src/tools/n8n/chat-actions.ts`: public submit/status/result tools, dry-run behavior, caller checks.
- `src/server/chat-action-jobs.ts`: service authentication, accepted caller lanes, idempotent/caller-bound persistence, internal routes.
- `src/server/chat-action-executor.ts` and `src/server/chat-action-worker.ts`: executor allowlist, caller propagation, pre-claim protected-content rejection, terminal result persistence.
- `n8n-workflows/chat-action-submit.json`, `chat-action-status.json`, `chat-action-result.json`: HMAC validation, company lane allowlist, gateway credential binding, inactive import metadata.
- `docs/chat-n8n-action-contract.md`: import order, protected configuration requirements, and required synthetic acceptance checks.
- `src/n8n/chat-action-client.test.ts`, `src/server/chat-action-jobs.test.ts`, `src/server/chat-action-executor.test.ts`, `src/server/chat-action-worker.test.ts`: local contract coverage for paths, rejection, idempotency, caller propagation, and worker behavior.
- `docs/WEFUNDER-CODEX-SCOPED-SEAT.md` and `docs/CHATGPT-CONNECT.md`: dedicated WeFunder identity and connector role boundary.
