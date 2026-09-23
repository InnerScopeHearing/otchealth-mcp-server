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
