# Unified Fleet Gateway

The one custom MCP every AI client connects to for the OTCHealth/InnerScope stack.
This doc is the source of truth for what the gateway IS, what is actually wired vs.
planned, the security model, and how to add a module. It is referenced by
`otchealth-cto/CLAUDE.md` and `otchealth-claude-tools/dream-team/FLEET-CAPABILITY-MAP.md`.

## What it is
A Node + Fastify + MCP-SDK server (`src/server`) that exposes the fleet's tools behind
one endpoint with bearer + OAuth auth, scoped gating, a compliance guardrail, and audit
logging. ADR-001 Option C (Node + n8n hybrid). Public endpoint (when deployed):
`https://mcp.otchealth.app/mcp`.

## Actual state (reconciled 2026-06-14 against the git history — READ THIS)
A prior cross-engine note claimed Depot, PostHog-management, and the Capability Catalog
were "added." They are NOT in this repo. The honest, code-verified state:

WIRED (on main, registered in `src/tools/index.ts`):
- **Customer.io** (Phase 1): 9 reads + 2 simple writes + 2 n8n-orchestrated writes.
- **Shopify** (Phase 2): list/get products, get order, list abandoned checkouts.
- **Intercom** (Phase 2): list/get articles.
- **n8n** (Phase 2 meta): list workflows, get execution.
- **Cloudflare** (COO-25): list/add email destinations + rules, list/create DNS records.
- **Microsoft Graph** (COO-25): send email (COO send-as), list messages.
- **Stripe** (COO-25, read-only): balance, charges, customers, payment intents, products.
- **Netlify** (Phase 3, this change, read-only): list sites, list site deploys.
- **Gumroad** (Phase 3, this change, read-only): list products, list sales.

AUTH: OAuth 2.0 endpoints (`src/server/oauth.ts`) + bearer (`src/auth/bearer.ts`) +
a revocation store (`src/auth/revocation-store.ts`). NOTE: verify this against the full
OAuth 2.1 description (DCR, PKCE-S256, resource-owner consent, RFC 9728) before relying
on it for the claude.ai/Hyperagent connect; the file is compact and may be a subset.

NOT YET BUILT (claimed elsewhere, absent here - this is the real backlog):
- **Depot** module (FULL API: builds, cache, usage/grant-burn). Highest-value next.
- **PostHog management** module - MUST enforce the PHI carve-out (no MedReview PHI data;
  project 468398 read-only at most) with a build-failing test.
- **Capability Catalog** (`catalog_list_tools`, `catalog_service_capabilities`,
  `catalog_audit_unused`) - the "don't leave features on the table" introspection layer.
- **RevenueCat** (v2 read), **Twilio + ElevenLabs** (voice fleet), **GitHub passthrough**.

## Security model (keys-to-the-kingdom; keep it hard)
- Every tool goes through `src/tools/registry.ts`: strict Zod input (rejects unknown
  fields), `applyGuardrail` compliance scan on outputs, audit log with correlation ids,
  and category gating (`READ_ONLY_MODE` / `ENABLE_WRITE_TOOLS` / `ENABLE_HIGH_RISK_TOOLS`,
  `DRY_RUN_DEFAULT`). Reads are always live; writes are gated + dry-run by default.
- **PHI ring is carved OUT.** No MedReview PHI data tools here, ever (BAA-absolute).
  Non-PHI infra config only.
- Credentials are server-side env only (`src/config/env.ts`, Zod-validated), never in
  agent context. New service creds are `z.string().optional().default('')` so the server
  boots without them and the tool fails closed with a clear `*_not_configured` error.
- Ingress should be locked to Cloudflare-only at the Azure container (Matt gate).

## Deploy state (Matt gates)
An older build is deployed on Azure (`otchealth-mcp.westus2.azurecontainer.io`,
`mcp.otchealth.app` CNAME, per BRF-10 2026-06-12). The current main needs a **redeploy**
plus env provisioning: `DEPOT_TOKEN`, `POSTHOG_PERSONAL_API_KEY`, `OAUTH_CONSENT_SECRET`,
`PUBLIC_BASE_URL` (and the per-service creds for any wired module you want live:
`NETLIFY_AUTH_TOKEN`, `GUMROAD_ACCESS_TOKEN`, `STRIPE_SECRET_KEY`, Cloudflare/Graph, etc.).
Until redeployed + added as a connector, the Capability Catalog (once built) is unavailable.

## How to add a module (the established pattern)
1. `src/<service>/api-client.ts` - undici `request`, a `<Service>ApiError` class, a
   `requireKey()` guard reading `loadEnv()`, a `<service>Request<T>()` helper, exported
   endpoint fns. Read-only first.
2. `src/tools/<service>/<tool>.ts` - `register<Tool>(server, callerHash)` calling
   `registerTool(server, { name, category, annotations, inputShape, outputShape, handler }, callerHash)`.
   Use `category: 'read'` for reads; `write_simple` / `write_orchestrated` for writes.
3. Add the env var(s) to `src/config/env.ts` (optional, default '').
4. Import + call the registrations in `src/tools/index.ts`.
5. Add a pure unit test `src/<service>/api-client.test.ts` (assert the `*_not_configured`
   error path; set the required base env vars first). Run `npm run typecheck && npm test`.
6. Keep outputs categorical/non-PII where the source carries PII (e.g. Gumroad sales omit
   buyer email from structured output).
