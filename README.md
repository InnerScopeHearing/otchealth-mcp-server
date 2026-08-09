# OTCHealth MCP Server

**Status:** Phase 1 built and tested locally against live Customer.io workspace 193366. Pending Railway deploy + Perplexity hookup.
**Owner:** Matt Moore (President, OTCHealth Inc.)
**Architecture:** ADR-001 (locked) — Option C hybrid, Node.js + n8n.

A remote MCP server exposing OTCHealth's operational stack (Customer.io first, then Shopify, Intercom, n8n, Notion in later phases) to Perplexity custom remote connectors and any other MCP client.

---

## TL;DR

```bash
npm install
npm run build
cp .env.example .env       # fill in 6 values
npm start                  # listens on $PORT (default 8080)
```

Endpoints:
- `GET /health` — public, returns operational flags
- `GET /version` — public, returns service version/build metadata
- `POST /mcp` — Streamable HTTP, JSON-RPC 2.0, bearer-auth required
- `POST /heygen/pair` — one-time HeyGen OAuth credential handoff (pair-id capability)
- `POST /admin/revoke` — kill-switch (separate admin token)
- `GET /admin/revoke`, `POST /admin/clear-revoke` — inspect / clear revocation

---

## HeyGen read-only OAuth broker

The HeyGen integration exposes only four fixed reads: `heygen_account_get`, `heygen_videos_list`,
`heygen_video_get`, and `heygen_video_agent_styles_list`. Each operation calls `GET /v3/users/me`
immediately before its target and refuses the target unless the account reports
`billing_type=subscription` with a populated `subscription`. The data tools are limited in-handler to
`cto`, `exec`, `coo`, `cro`, `cpo`, and `developer`; no generic request or generation/mutation/download
path exists.

Pairing is CTO-only:

1. Call `heygen_pairing_start` with `dry_run:false`. Its random 32-byte id expires after 15 minutes.
2. Build base64 from the official HeyGen credentials shape, exactly
   `{"oauth":{"access_token":"…","refresh_token":"…","expires_at":"…","scope":"…","token_type":"…"}}`.
   Any `api_key` field, including a nested one, is refused.
3. `POST /heygen/pair` with JSON `{"pair_id":"…"}` and the base64 value in
   `x-heygen-oauth-credentials`. The pair id is one-time and is consumed before the header is parsed.
4. Check `heygen_pairing_status`.

The broker requires Cosmos plus the existing `OAUTH_TOKEN_SIGNING_SECRET`. Tokens are derived-key
AES-256-GCM encrypted before durable storage (`ttl:-1`); only ciphertext/IV/tag and non-secret status
metadata are stored. OAuth refresh rotation uses an in-process mutex plus Cosmos ETags and persists a
new encrypted chain before returning its access token. Rotating `OAUTH_TOKEN_SIGNING_SECRET` makes the
old HeyGen ciphertext intentionally undecryptable, so run a fresh pairing after that rotation.

---

## Phase 1 tool catalog (13 tools)

| Tool | Type | Routing | Notes |
|------|------|---------|-------|
| `cio_list_newsletters` | read | direct | limit + cursor pagination, created_after/before filters |
| `cio_get_newsletter` | read | direct | optional `include_contents` |
| `cio_get_newsletter_metrics` | read | direct | optional `include_links` for link-level click data |
| `cio_get_newsletter_schedule` | read | direct | scheduled_at, original_scheduled_at, send_at, recurring |
| `cio_get_segment` | read | direct | optional `include_count` |
| `cio_list_segment_people` | read | direct | paginated |
| `cio_get_customer` | read | direct | by email / cio_id / id; optional segments |
| `cio_get_template_or_content` | read | direct | best-effort; returns `unsupported_via_api` if no path works |
| `cio_get_broadcast_history_for_segment` | read | direct | join newsletters→segment, optional metrics |
| `cio_track_event` | write_simple | direct (Track API) | event name allowlisted; dry-run default |
| `cio_update_customer_attributes` | write_simple | direct (Track API) | protected attrs rejected; dry-run default |
| `cio_update_newsletter_variant` | write_orchestrated | n8n webhook | field allowlist; HMAC-signed payload |
| `cio_duplicate_newsletter` | write_orchestrated | n8n webhook | best-effort; falls back to `unsupported_via_api` |

Every tool returns a `structuredContent` JSON envelope:

```json
{
  "result": { /* tool-specific payload */ },
  "compliance_warning": null,
  "correlation_id": "uuid-v4",
  "dry_run": false
}
```

Every tool annotates: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (ADR-001 §4d).

---

## Architecture

```
        Perplexity (custom remote connector)
              │
              │  Authorization: Bearer <PERPLEXITY_CONNECTOR_TOKEN>
              │  POST https://<railway-url>/mcp
              ▼
   ┌─────────────────────────────────────────────────┐
   │ Fastify (Node 20+ / Streamable HTTP, stateless) │
   │   • bearer auth + revocation check              │
   │   • Zod input validation                        │
   │   • Pino structured audit log (correlation_id)  │
   │   • compliance guardrail scan on output         │
   │   • write-tool feature flags                    │
   └─────┬───────────────────────────────────┬───────┘
         │                                   │
         │ direct (HTTPS, undici)            │ HMAC-SHA256 signed POST
         │                                   │
         ▼                                   ▼
   Customer.io App API                  n8n webhooks
   https://api.customer.io/v1/...       https://otchealth.app.n8n.cloud/webhook/...
   Customer.io Track API                (cio_update_newsletter_variant)
   https://track.customer.io/api/v1/... (cio_duplicate_newsletter)
```

See ADR-001 §3 for the locked tech stack and §4 for the read-vs-orchestrated routing decisions.

---

## Setup

### Prerequisites

- Node.js 20 LTS or newer (this build was validated on Node 24.15.0 — see "Node version note" below)
- npm 10+
- Git
- For deployment: Railway account, GitHub PAT (read at deploy time from Matt's Notion Token Vault)

> **Node version note:** ADR-001 §3 specifies "Node.js 20 LTS". By May 2026, Node 20 reached end-of-life and the current LTS line is Node 22+. This build runs on Node 22, 24, or any later LTS. The `engines.node` field is set to `>=20` to allow either. If Node 20 is required for compliance reasons, use `nvm install 20 && nvm use 20` — there are no v22/v24-only APIs in this code.

### Environment variables

Copy `.env.example` to `.env` and populate. The full list:

| Variable | Source | Notes |
|----------|--------|-------|
| `CIO_SITE_ID` | Customer.io UI → Settings → API Credentials | Track API Basic-auth username |
| `CIO_TRACK_KEY` | Customer.io UI → Settings → API Credentials | Track API Basic-auth password |
| `CIO_APP_API_BEARER` | Customer.io UI → Settings → API Credentials | App API bearer token |
| `PERPLEXITY_CONNECTOR_TOKEN` | Generated at first build (32-byte hex) | Perplexity bearer to MCP |
| `ADMIN_REVOKE_TOKEN` | Generated at first build (32-byte hex) | Kill-switch bearer; keep separate from connector token |
| `N8N_BASE_URL` | n8n cloud URL | Default: `https://otchealth.app.n8n.cloud` |
| `N8N_API_KEY` | n8n → Settings → API | Pulled at orchestrated-write registration time; optional for read-only first deploy |
| `N8N_WEBHOOK_SECRET` | Generated at first build (32-byte hex) | HMAC shared secret with n8n |
| `READ_ONLY_MODE` | feature flag | `true` on first deploy (hard gate; see §7 ADR) |
| `ENABLE_WRITE_TOOLS` | feature flag | `false` first deploy |
| `ENABLE_HIGH_RISK_TOOLS` | feature flag | `false` first deploy; gates n8n-routed writes |
| `DRY_RUN_DEFAULT` | feature flag | `true` first deploy |
| `PORT` | server | Default 8080; Railway sets this automatically |
| `NODE_ENV` | server | `production` in deploys, `development` locally for pretty logs |
| `LOG_LEVEL` | server | `info` default; `debug` for tool-call detail |

The three generated tokens are stored in Matt's Notion Token Vault (see "Operator playbook → Rotate secrets" below).

### Local development

```bash
npm install
cp .env.example .env       # fill in 6 values (3 CIO + 3 generated)
npm run dev                # tsx watch on src/server/index.ts
# OR
npm run build && npm start # production mode
```

Smoke test:

```bash
# health (no auth)
curl http://localhost:8080/health

# tools/list (requires bearer)
curl -X POST http://localhost:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $PERPLEXITY_CONNECTOR_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# live read against workspace 193366
curl -X POST http://localhost:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $PERPLEXITY_CONNECTOR_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"cio_list_newsletters","arguments":{"limit":5}},"id":2}'
```

---

## Security

Per Perplexity Spec §6 and ADR §6:

1. **Secrets** — env vars only. Never logged (Pino redacts authorization headers, all `*_token` / `*_secret` / `*_key` paths). Never in repo (.env in .gitignore). Never in error objects.
2. **Auth** — bearer token on every `/mcp` request. Constant-time comparison. SHA256 hash of caller token is logged for traceability; raw token never is.
3. **Authorization classes** — three feature flags gate three risk tiers (`READ_ONLY_MODE`, `ENABLE_WRITE_TOOLS`, `ENABLE_HIGH_RISK_TOOLS`). Write tools rejected with `write_disabled` error code unless all relevant flags allow.
4. **Audit logging** — every tool call writes `tool_call_start` and `tool_call_end` JSON log lines with: correlation_id, tool name, caller_hash (SHA256), sanitized inputs, dry_run flag, read_only_mode flag, outcome (success / error / rejected), latency_ms, error_code, error_message. Writes include `before` and `after` payloads in the end log.
5. **Schema validation** — every tool input goes through a Zod schema before the handler runs. Strong types, sensible bounds (`limit ≤ 200`, etc.).
6. **Data minimization** — Pino `redact` masks emails and phone numbers in log payloads via `maskPii`. Errors include `next_step` guidance, not stack traces.
7. **Compliance guardrail** — every tool output is scanned for INND ticker mentions, patent-claim language, 510(k) overclaims, A-grade HearAdvisor claims, pre-shipment availability claims, and TReO-as-hearing-aid mentions (ADR §10). Triggers attach a `compliance_warning` and require `acknowledge_warning=true` on the caller side before the data is rendered.

### Known limitations

- **Strict-mode input rejection is silent.** The MCP SDK's input-schema validator silently strips unknown fields before the tool handler runs. Unknown fields are *ignored*, not loudly rejected. Security intent (no pass-through to upstream APIs) is preserved. Fix path: pre-validate the raw JSON-RPC params before delegating to the SDK; deferred.
- **`cio_get_template_or_content` is best-effort.** Customer.io does not consistently expose newsletter HTML through any public API path; the tool tries several documented endpoints and returns `source: "unsupported_via_api"` when none succeed.
- **`cio_duplicate_newsletter` may not actually duplicate.** Customer.io's public docs are inconsistent on whether `POST /newsletters/{id}/duplicate` exists. The n8n workflow returns `unsupported_via_api` cleanly when 404'd.
- **Compliance guardrail uses substring patterns, not NLP.** False positives are possible (a legitimate use of "INND" in an IR-approved context). Pass `acknowledge_warning=true` to render. False negatives are possible if content is obfuscated (e.g., "I.N.N.D.").
- **Single-instance kill-switch.** `POST /admin/revoke` writes to in-memory state. Process restart clears the revocation by design. For permanent lockout: rotate `PERPLEXITY_CONNECTOR_TOKEN` in Railway, redeploy.

---

## Deployment (Railway)

1. Push `main` to `github.com/GBGolfMatt/otchealth-mcp-server` (private).
2. In Railway: New Project → Deploy from GitHub repo.
3. Set all env vars in Railway → Settings → Variables. Match `.env.example` keys.
4. **First deploy MUST ship with `READ_ONLY_MODE=true`.** Hard gate from ADR §7.
5. Confirm `GET /health` over HTTPS returns 200 with the flags you set.
6. Confirm `POST /mcp` with `tools/list` returns 13 tools.
7. Then add the connector in Perplexity (see next section).

`Dockerfile` is multi-stage (build → runtime, runs as non-root `app` user, Alpine-based). Railway auto-detects it.

### Rollback

```bash
# Railway dashboard: Deployments → click previous successful deploy → Redeploy
# Or git revert and push
git revert <bad-sha> && git push
```

---

## Connecting from Perplexity

1. Perplexity → Settings → Connectors → "Add custom connector" → "Remote".
2. URL: `https://<your-railway-app>.up.railway.app/mcp`
3. Auth method: Bearer token.
4. Token value: `<PERPLEXITY_CONNECTOR_TOKEN>` from `.env` (or Matt's Notion vault).
5. Save.
6. Test with a natural-language query: *"Using the OTCHealth MCP connector, list the names of the most recent 5 Customer.io newsletters."*

If you get an `unauthorized` response, the token has either been mis-pasted or revoked. See operator playbook.

---

## Operator playbook

### Rotate the connector bearer token

When (suspected leak, quarterly cadence, end of a contractor's access window):

```bash
# 1. Generate a new 32-byte hex token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Update Railway env var PERPLEXITY_CONNECTOR_TOKEN
# 3. Restart the Railway service (auto on env-var change)
# 4. Update Matt's Notion vault (https://www.notion.so/35d20e2667bc81c2b055cfc612a7e9b5)
#    with the new value and Last rotated date.
# 5. Update Perplexity → Connectors → OTCHealth → bearer token.
```

Same procedure for `ADMIN_REVOKE_TOKEN` and `N8N_WEBHOOK_SECRET` (note: rotating the n8n webhook secret requires re-syncing it on the n8n side too).

### Revoke without restarting (kill-switch)

```bash
curl -X POST https://<railway-url>/admin/revoke \
  -H "authorization: Bearer $ADMIN_REVOKE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"reason":"suspected leak via Perplexity workspace"}'
```

Response:

```json
{"status":"revoked","revoked_at":"2026-05-11T22:11:23.000Z","revoked_token_hash":"<sha256>","reason":"..."}
```

The connector token starts returning 401 immediately. `/health` will report `connector_token_revoked: true`. To clear (after rotation):

```bash
curl -X POST https://<railway-url>/admin/clear-revoke \
  -H "authorization: Bearer $ADMIN_REVOKE_TOKEN"
```

### Disable write tools

```bash
# In Railway → Settings → Variables:
READ_ONLY_MODE=true
ENABLE_WRITE_TOOLS=false
ENABLE_HIGH_RISK_TOOLS=false
# Then redeploy. Write tools immediately start returning write_disabled.
```

### Inspect logs

Railway → Deployments → Logs. Filter on:

```
type:tool_call_start    → all incoming tool calls
type:tool_call_end      → outcomes + latencies
type:auth_rejected      → bad bearer attempts
type:admin_revoke_*     → kill-switch activity
type:cio_app_api_*      → Customer.io upstream errors
```

Each log line includes a `correlation_id` (UUIDv4). The same id appears in the response `structuredContent.correlation_id` field returned to Perplexity, so you can trace a single call end-to-end.

### Audit a specific tool call

1. Get the correlation_id from Perplexity's tool-call output.
2. Railway logs → search for that id.
3. The `tool_call_start` line has sanitized inputs; the `tool_call_end` line has outcome + before/after diffs for writes.

---

## Phase 2 roadmap (scaffolded, not implemented)

Per PERPLEXITY_SPEC §5:

- **Shopify** (8 tools): products, analytics, abandoned checkouts, draft orders, product copy edits
- **Intercom** (6 tools): help center, conversations, articles, internal notes
- **n8n** (6 tools): workflow listing, executions, triggers, recent failures
- **Notion** (4 tools): pages, databases, ops-database writes
- **ElevenLabs / Twilio** (optional): agent prompts, phone routing

Implementation pattern: add `src/tools/<provider>/<action>.ts` files, register in `src/tools/index.ts`, scope each integration's API client into its own `src/<provider>/` directory.

---

## Repo layout

```
.
├── ADR-001.md                       # locked architecture decision (read first)
├── PERPLEXITY_SPEC.md               # original mega-prompt
├── Dockerfile                       # multi-stage, non-root
├── package.json
├── tsconfig.json
├── .env.example                     # template
├── .env                             # gitignored
├── evals/
│   └── phase1.xml                   # 10 read-only eval questions (ADR §8)
├── n8n-workflows/
│   ├── cio-update-newsletter-variant.json
│   └── cio-duplicate-newsletter.json
└── src/
    ├── config/env.ts                # Zod env validation
    ├── audit/logger.ts              # Pino + redaction + correlation IDs
    ├── auth/
    │   ├── bearer.ts                # connector + admin bearer middleware
    │   └── revocation-store.ts      # in-memory kill-switch
    ├── compliance/guardrail.ts      # regulated_data_guardrail (ADR §10)
    ├── customerio/
    │   ├── app-api-client.ts        # App API (bearer)
    │   └── track-api-client.ts      # Track API (basic)
    ├── n8n/webhook-client.ts        # HMAC-signed n8n bridge
    ├── tools/
    │   ├── registry.ts              # central tool wrapper (validation + audit + guardrail + gates)
    │   ├── index.ts                 # registers all 13 tools
    │   └── cio/                     # 13 tool files
    └── server/
        ├── index.ts                 # Fastify entrypoint
        ├── mcp.ts                   # POST /mcp (Streamable HTTP, stateless)
        ├── admin.ts                 # POST /admin/revoke
        ├── health.ts                # GET /health
        ├── version.ts               # GET /version
        └── request-context.ts       # AsyncLocalStorage for caller_hash
```

---

## Owner

Matt Moore, President, OTCHealth Inc. — Granite Bay, CA.
