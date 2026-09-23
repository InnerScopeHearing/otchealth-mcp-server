# Ordinary Chat n8n action contract

This bridge is a narrow execution seam for ordinary Chat agents. It does not expose the n8n API, credentials, workflow definitions, or arbitrary webhook paths.

The gateway signs three calls with the existing `N8N_WEBHOOK_SECRET`:

| Webhook | Request | Required response |
| --- | --- | --- |
| `/webhook/chat-action-submit` | `action`, `request`, `idempotency_key` | `{ "job_id": "opaque", "status": "queued" }` |
| `/webhook/chat-action-status` | `job_id` | `{ "job_id": "opaque", "status": "queued\|running\|succeeded\|failed" }` |
| `/webhook/chat-action-result` | `job_id` | status envelope plus `result` or `error` |

Supported actions are `brain_search` and `checkpoint`. n8n should call the existing gateway contracts using its protected service connection and store only the opaque job record and non-sensitive action result required by the workflow.

Requests are rejected before network I/O when any `agent`, `scope`, or `room` field identifies `clo-personal`. The submit idempotency key is mandatory so retries return the original job instead of starting a second workflow.

Import and deployment sequence:

1. In n8n, import each JSON from `n8n-workflows/` using Workflows, Import from File. Leave all three inactive.
2. Confirm the existing HTTP Header Auth credential is named exactly `OTCHealth Gateway Service`, and bind it on the HTTP Request node in each workflow. Do not create a credential with a value in the workflow file.
3. Set `N8N_GATEWAY_BASE_URL` to the gateway origin and set `N8N_WEBHOOK_SECRET` to the already provisioned n8n webhook secret in the n8n environment. Never put either value in a workflow export.
4. Deploy the gateway internal job endpoints referenced by the workflows: `/internal/chat-actions/jobs`, `/internal/chat-actions/jobs/status`, and `/internal/chat-actions/jobs/result`. The gateway service must persist only opaque job ids and the bounded action result, enforce caller binding, and keep the personal-legal lane unavailable.
5. Send synthetic requests with a generated HMAC and an opaque job id. Confirm invalid signatures receive 401, submit returns `job_id` and `status`, status returns only the state envelope, and result returns the bounded result. Activate the workflows only after those checks pass.
