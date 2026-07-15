import { z } from 'zod';

const EnvSchema = z.object({
  // Customer.io
  CIO_SITE_ID: z.string().min(1, 'CIO_SITE_ID is required'),
  CIO_TRACK_KEY: z.string().min(1, 'CIO_TRACK_KEY is required'),
  CIO_APP_API_BEARER: z.string().min(1, 'CIO_APP_API_BEARER is required'),

  // MCP server auth
  PERPLEXITY_CONNECTOR_TOKEN: z
    .string()
    .min(32, 'PERPLEXITY_CONNECTOR_TOKEN must be at least 32 chars'),
  ADMIN_REVOKE_TOKEN: z
    .string()
    .min(32, 'ADMIN_REVOKE_TOKEN must be at least 32 chars'),

  // Long-lived low-privilege token for the GitHub Copilot coding agents' MCP header.
  // Maps to caller_agent='copilot-agent' (reads/commons/llm_azure/guardrails only; NO privileged RAG,
  // NO GitHub writes, NO builds). Inert when unset. Rotate-before-launch.
  COPILOT_AGENT_TOKEN: z.string().optional().default(''),

  // n8n
  N8N_BASE_URL: z
    .string()
    .url()
    .default('https://automation.otchealth.app'),
  N8N_API_KEY: z.string().optional().default(''),
  N8N_WEBHOOK_SECRET: z
    .string()
    .min(32, 'N8N_WEBHOOK_SECRET must be at least 32 chars'),

  // GitHub webhook ingestion (fleet-medic). Inert when unset; HMAC-SHA256 verified.
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
  // Fleet-medic v2: auto-merge AGENT-authored PRs when their checks go green (branch protection gates).
  FLEET_MEDIC_AUTOMERGE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Where the webhook routes human+agent-visible fleet-medic alerts (issue comments).
  FLEET_MEDIC_LOG_REPO: z.string().optional().default('InnerScopeHearing/otchealth-mcp-server'),
  FLEET_MEDIC_LOG_ISSUE: z.string().optional().default('21'),

  // Cloudflare
  CLOUDFLARE_API_TOKEN: z.string().optional().default(''),
  CLOUDFLARE_ZONE_ID: z.string().optional().default(''),

  // Microsoft Graph (COO send-as coo@otchealthmart.com)
  GRAPH_TENANT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_SECRET: z.string().optional().default(''),
  GRAPH_SENDER_EMAIL: z.string().optional().default('coo@otchealthmart.com'),

  // Stripe (read-only)
  STRIPE_SECRET_KEY: z.string().optional().default(''),

  // OAuth 2.1 (confidential client). When OAUTH_CLIENT_ID + OAUTH_TOKEN_SIGNING_SECRET are set,
  // the gateway issues real expiring JWT access/refresh tokens (PKCE S256 mandatory). When unset,
  // the legacy static-connector-token behavior is preserved for back-compat.
  OAUTH_CLIENT_ID: z.string().optional().default(''),
  OAUTH_CLIENT_SECRET: z.string().optional().default(''),
  OAUTH_TOKEN_SIGNING_SECRET: z.string().optional().default(''),
  OAUTH_REDIRECT_URIS: z.string().optional().default(''),
  PUBLIC_BASE_URL: z.string().optional().default(''),
  // Per-agent OAuth clients (P2b): JSON array [{"client_id":"..","secret":"..","agent":"developer"}].
  // Each connecting client maps to an agent lane; the issued token carries that agent identity.
  OAUTH_CLIENTS: z.string().optional().default(''),
  // Agent identity for the single OAUTH_CLIENT_ID connection (the original Hyperagent CTO connector).
  OAUTH_DEFAULT_AGENT: z.string().optional().default(''),
  // Default ring lane bound to Dynamic-Client-Registration (Claude connector) clients.
  OAUTH_DCR_DEFAULT_AGENT: z.string().optional().default(''),
  // Curated csv toolset advertised to Claude Chat DCR connector clients (empty -> built-in default).
  CONNECTOR_TOOLSET: z.string().optional().default(''),

  // Descope Agentic Identity Hub -- OPTIONAL parallel credential path for approved pilot lanes
  // (Phase 2, 2026-07-08). Inert when DESCOPE_PROJECT_ID is unset -- does not touch or replace
  // any existing OAuth lane above. When set, auth/bearer.ts additionally accepts a Descope-
  // issued RS256 session JWT as a valid credential, gated to DESCOPE_PILOT_LANES. Two Descope
  // mechanisms are both accepted: (1) Access Keys, exchanged via POST /v1/auth/accesskey/exchange,
  // carrying an explicit `lane` custom claim; (2) Inbound App Clients (the object type that
  // populates Descope's "Agentic Identity" Console dashboard), issued via the standard OAuth2
  // client_credentials grant at POST /oauth2/v1/apps/token, carrying a `scope` claim instead --
  // mapped to a lane via DESCOPE_SCOPE_LANE_MAP below. See auth/descope.ts.
  DESCOPE_PROJECT_ID: z.string().optional().default(''),
  // CSV of lane values accepted from a Descope token (from either the `lane` claim or a mapped
  // `scope`). Defaults to just the pilot lane ("clo") even if this var is left unset -- widening
  // it is a config change, not a code change, but still requires DESCOPE_PROJECT_ID to be set
  // for the feature to be reachable.
  DESCOPE_PILOT_LANES: z.string().optional().default(''),
  // JSON object string mapping an Inbound App Client's OAuth `scope` value to a lane, e.g.
  // {"mcp:legal.read":"clo"}. Optional -- an unset or malformed value falls back to a built-in
  // default covering the 3 real Inbound App Clients provisioned 2026-07-08 (mcp:legal.read ->
  // clo, mcp:legal.personal.read -> clo-personal, mcp:infra.admin -> cto), so this can stay
  // unset in production today. Set it to widen/replace the mapping without a redeploy. A token
  // whose scopes map to more than one distinct lane is always rejected as ambiguous, regardless
  // of this map's contents -- see auth/descope.ts's laneFromScope().
  DESCOPE_SCOPE_LANE_MAP: z.string().optional().default(''),

  // Semantic recall over the memory-exec Azure AI Search index (read-only QUERY key).
  // Inert when unset -> memory_recall falls back to keyword search over the blob feed.
  AZURE_SEARCH_ENDPOINT: z.string().optional().default(''),
  AZURE_SEARCH_QUERY_KEY: z.string().optional().default(''),

  // Feature flags
  READ_ONLY_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ENABLE_WRITE_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENABLE_HIGH_RISK_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DRY_RUN_DEFAULT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Server
  PORT: z
    .string()
    .default('8080')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n > 0 && n < 65536, 'PORT must be a valid port number'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // CIO workspace (informational, used in error messages)
  CIO_WORKSPACE_ID: z.string().default('193366'),

  // Phase 2: Shopify (hearingassist.myshopify.com / otchealthmart.com)
  SHOPIFY_SHOP: z.string().optional().default(''),
  SHOPIFY_API_VERSION: z.string().optional().default('2024-10'),
  SHOPIFY_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 2: Intercom
  INTERCOM_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 3: Netlify (INND site + portfolio deploy visibility, read-only)
  NETLIFY_AUTH_TOKEN: z.string().optional().default(''),

  // Phase 3: Gumroad (digital-products cash lane scoreboard, read-only)
  GUMROAD_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 4: kb-memory shared brain (commons store ONLY; non-PHI, non-MNPI, non-privileged
  // by construction). Inert without these. Mirrors skills/kb-memory commons (otchealthcommons /
  // company-journal). NEVER wire the cfo/clo/clo-personal/PHI storage accounts here.
  AZURE_COMMONS_STORAGE_ACCOUNT: z.string().optional().default(''),
  AZURE_COMMONS_STORAGE_KEY: z.string().optional().default(''),

  // Agent State Plane - Cosmos DB for NoSQL work-ledger + structured memory-of-record.
  // Inert without COSMOS_ENDPOINT/COSMOS_KEY. Non-PHI, non-MNPI, non-privileged by construction
  // (the clo-personal lane is rejected). Verbatim-critical records live here, never in an
  // LLM-consolidated store.
  COSMOS_ENDPOINT: z.string().optional().default(''),
  COSMOS_KEY: z.string().optional().default(''),
  COSMOS_DB: z.string().optional().default('agent-state'),

  // Agent inbox (Azure Storage Queue). Inert without these. Durable cross-agent handoff delivery.
  AGENT_INBOX_STORAGE_ACCOUNT: z.string().optional().default(''),
  AGENT_INBOX_STORAGE_KEY: z.string().optional().default(''),

  // Legal document store (Azure Blob, account otchealthlegalstore, containers company | personal).
  // RING-GATED (personal = attorney-privileged CA divorce/civil matters — the most sensitive corpus
  // in the fleet). SharedKey auth, mirrors skills/legal/legal.mjs (secrets azure-legal-storage-account
  // / azure-legal-storage-key). Inert without these — legal_blob_* return a clear "not configured"
  // result rather than throwing. The account defaults to otchealthlegalstore (as in the skill).
  AZURE_LEGAL_STORAGE_ACCOUNT: z.string().optional().default('otchealthlegalstore'),
  AZURE_LEGAL_STORAGE_KEY: z.string().optional().default(''),

  // OneDrive / Graph Drive three-folder exchange (Outgoing/Incoming/Processed), per role. The
  // gateway uses APP-ONLY Graph auth (GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET, Files.ReadWrite.All)
  // and targets a specific user's drive: /users/{upn}/drive/root:/<path>. GRAPH_DRIVE_USER is the
  // drive owner (the OneDrive whose role folders are exchanged, e.g. matthew@innd.com). Inert without
  // Graph creds — graph_drive_* return a clear "not configured" result.
  GRAPH_DRIVE_USER: z.string().optional().default(''),

  // Optional: lets task_complete verify gh:commit/gh:pr artifact_uris. Absent -> gh: is rejected
  // (agents land the artifact in the commons instead). Read-only classic/fine-grained token.
  GITHUB_TOKEN: z.string().optional().default(''),

  // Wave A: Azure AI Content Safety (Prompt Shields + groundedness) — gateway-level guardrails.
  // Inert when unset (tools return a flagged "skipped" result rather than throwing).
  CONTENT_SAFETY_ENDPOINT: z.string().optional().default(''),
  CONTENT_SAFETY_KEY: z.string().optional().default(''),
  // AUTO-GUARD modes are NOT in this schema on purpose: like COMPLIANCE_MODE / GOVERNANCE_MODE, they are
  // read FRESH from process.env by src/safety/auto-guard.ts (via the registerTool wrapper) so they can be
  // flipped by an env change with no code redeploy:
  //   SHIELD_MODE       off | report (default) | enforce   — inbound Prompt Shields on tool args
  //   GROUNDEDNESS_MODE off (default) | report | enforce    — outbound groundedness on tools that surface a hint
  // 'report' runs the check and annotates/logs but never blocks; 'enforce' blocks (inbound: pre-handler;
  // outbound: read-only tools only). All fail-open + inert until CONTENT_SAFETY_* above is set.

  // llm_azure SEMANTIC RESPONSE CACHE (src/tools/llm/semantic-cache.ts). Also NOT in this schema on
  // purpose, same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE above — read fresh per call so it can be
  // flipped without a redeploy:
  //   LLM_CACHE_MODE                  off (default) | on  — cache-check before every llm_azure call
  //   LLM_CACHE_SIMILARITY_THRESHOLD  cosine similarity floor for a hit, 0..1 (default 0.95)
  // Fail-open end to end: any cache error (Cosmos down, embed() throws) falls through to a normal
  // model call. Reuses the existing Cosmos `cache` container (COSMOS_ENDPOINT/COSMOS_KEY above) and
  // the existing Foundry embed() (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY above) — no new credentials.
  //
  // llm_azure FAQ/INTENT DEFLECTION (src/tools/llm/faq-deflect.ts). Also NOT in this schema on
  // purpose, same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE above — read fresh per call so it can
  // be flipped without a redeploy:
  //   FAQ_DEFLECT_MODE                  off (default) | on  — deterministic FAQ/intent check before
  //                                     any llm_azure task='complete' model call; a high-confidence
  //                                     match returns a curated canned answer with NO model call at
  //                                     all (Claude AND Azure tokens saved). Long-tail/low-confidence
  //                                     questions fall through to the normal llm_azure path unchanged.
  //   FAQ_DEFLECT_SIMILARITY_THRESHOLD  cosine similarity floor for a deflection hit, 0..1 (default 0.93)
  // Pattern = Azure AI App Template #41 (Language CLU/CQA conversational-agent accelerator),
  // adapted cost-neutrally: reuses the existing Cosmos `cache` container (COSMOS_ENDPOINT/COSMOS_KEY
  // above) and the existing Foundry embed() (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY above) under a
  // distinct partition ("faq:global") instead of provisioning a new Azure AI Language resource.
  // ORDER: FAQ deflection runs BEFORE the semantic cache, which runs before the model call.

  // COLD-START GATE (src/safety/cold-start.ts, Phase 1 coldstart-doctrine). Also NOT in this schema
  // on purpose, same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE above — read fresh per call so it can
  // be flipped without a redeploy:
  //   COLD_START_MODE  off | warn (default) | enforce
  // Tracks, per bearer identity (an in-memory Map, TTL ~6h, no new store), whether `wake` has been
  // called recently. 'warn' attaches a non-fatal COLD_START warning to a MUTATING (non-'read') tool
  // call from a session that skipped wake(); the tool still runs. 'enforce' refuses the call before
  // the handler runs. 'off' is a full no-op. Reads are NEVER gated. Fail-open end to end: an
  // unavailable bearer identity, or any internal error, always ALLOWS the call.

  // CAPTURE PLANE (Phase 2, src/safety/journal.ts + src/safety/capture-pressure.ts +
  // src/tools/memory/checkpoint.ts). THREE env flags, all NOT in this schema on purpose, same
  // reasoning as COLD_START_MODE above -- read fresh from process.env per call so they can be
  // flipped without a redeploy:
  //   AUTO_JOURNAL_MODE          off | on (default)
  // Every SUCCESSFUL, MUTATING, non-dry-run tool call fires a best-effort "episode" memory (fired
  // WITHOUT being awaited, so it can never add latency or fail the response it rides on). 'off'
  // skips the episode write entirely; capture-pressure counting (below) still runs regardless.
  //   CAPTURE_MODE               off | warn (default)
  //   CAPTURE_PRESSURE_THRESHOLD a positive integer (default 10)
  // Tracks, per bearer identity (a separate in-memory Map from cold-start's, no TTL, no new
  // store), how many mutating tool calls have happened since the caller last called checkpoint().
  // 'warn' attaches a non-fatal CAPTURE_PRESSURE nudge once the threshold is crossed, urging a
  // checkpoint() call; there is no 'enforce' mode (this is always advisory). 'off' is a full
  // no-op. Reads and dry-runs are NEVER counted. Fail-open end to end: an unavailable bearer
  // identity, or any internal error, never affects the call. Both the episode-write path and the
  // counter are PER-REPLICA (the gateway runs 2-10 replicas) -- acceptable for a soft nudge; the
  // durable signal is the episodes themselves in Cosmos, not the in-memory counter.

  // JIT DOCTRINE v1 (Phase 2, src/safety/jit-doctrine.ts). Also NOT in this schema on purpose, same
  // reasoning as COLD_START_MODE above -- read fresh from process.env per call so it can be flipped
  // without a redeploy:
  //   JIT_DOCTRINE_MODE  off | warn (default)
  // Binds a known, ledgered pitfall (JIT_DOCTRINE_BINDINGS, keyed by exact tool name or tool-name
  // prefix) to the tool it applies to, and attaches it to the response of THAT tool call -- doctrine
  // at the point of use, not only at wake(). Evaluated for EVERY tool category (read and write),
  // unlike COLD_START_MODE/CAPTURE_MODE which only apply to mutating calls: a pitfall on a read tool
  // (e.g. a PostHog read defaulting to the PHI project) is exactly when the warning is needed. 'warn'
  // is the only active mode (no 'enforce' in v1, always advisory, never blocks). 'off' is a full
  // no-op. Throttled once per (caller, tool) pair per process (an in-memory Set, no TTL, no new
  // store, PER-REPLICA like the capture plane above) so the same pitfall does not nag on every call.
  // Fail-open end to end: an unrecognized tool, an unavailable bearer identity, or any internal
  // error, always returns no doctrine rather than ever throwing or affecting the call.

  // INCIDENT MATCH (Phase 4 component C, src/safety/incident-match.ts). Also NOT in this schema on
  // purpose, same reasoning as JIT_DOCTRINE_MODE/AUTO_JOURNAL_MODE above -- read fresh from
  // process.env per call so it can be flipped without a redeploy:
  //   INCIDENT_MATCH_MODE  off | on (default)
  // The incident_match tool takes free text describing the current situation and semantically
  // searches memory-exec (filtered to type in (pitfall, correction)) for the single most similar
  // past incident, surfacing it only when its score clears a confidence threshold. 'on' is the only
  // active mode beyond 'off' (no 'enforce' -- this is always advisory, explicitly invoked, and never
  // blocks). Throttled once per (caller, matched-incident-id) pair per process (an in-memory Set, no
  // TTL, no new store, PER-REPLICA like the capture plane above) purely as an `already_surfaced`
  // annotation -- unlike JIT_DOCTRINE_MODE's throttle, it never hides a real match (see the file
  // header's THROTTLE IS ANNOTATION-ONLY section for why). Fail-open end to end: an unconfigured
  // Search/Foundry, a network outage, or any internal error always returns "no match" rather than
  // ever throwing or affecting the caller. Standalone in this pass -- NOT yet wired into the shared
  // hot mutation path (registry.ts) the way jit-doctrine is; that is a documented fast-follow.

  // Wave A: Azure Document Intelligence (CFO invoices + CLO contracts; read/analyze only, non-BAA).
  // NEVER send PHI/MedReview documents through this gateway.
  DOCINTEL_ENDPOINT: z.string().optional().default(''),
  DOCINTEL_KEY: z.string().optional().default(''),

  // Wave A: Azure AI Foundry (otchealth-foundry, AIServices) — credit-funded OpenAI-family endpoint.
  // Powers hybrid-search query embeddings (text-embedding-3-large) and the llm_cheap commodity path
  // (gpt-4.1-mini). The FLEET COST PROTOCOL escape hatch: move commodity LLM work off metered Claude.
  FOUNDRY_OPENAI_ENDPOINT: z.string().optional().default(''),
  FOUNDRY_KEY: z.string().optional().default(''),
  // Quality tiers (gpt-4.1-mini is BANNED for quality work — it failed the doc-repo summarization).
  // standard = gpt-5.1 (good, well-rounded); high = gpt-5.4 (strongest deployed). gpt-5.5 pending quota.
  FOUNDRY_CHAT_DEPLOYMENT: z.string().optional().default('gpt-5.1'),
  FOUNDRY_HIGH_DEPLOYMENT: z.string().optional().default('gpt-5.4'),
  FOUNDRY_EMBED_DEPLOYMENT: z.string().optional().default('text-embedding-3-large'),
  // Azure AI Model Router (otchealth-router, eastus2) — auto-routes to the cheapest-sufficient model.
  FOUNDRY_ROUTER_ENDPOINT: z.string().optional().default(''),
  FOUNDRY_ROUTER_KEY: z.string().optional().default(''),
  FOUNDRY_ROUTER_DEPLOYMENT: z.string().optional().default('model-router'),

  // Connectors wired in P3 wave 1 (read-only)
  SENTRY_AUTH_TOKEN: z.string().optional().default(''),
  SENTRY_ORG: z.string().optional().default('otchealth-inc'),
  REVENUECAT_API_KEY: z.string().optional().default(''),

  // Connectors wired in P3 wave 2 (read-only; PostHog MedReview project carved out; depot reads only)
  POSTHOG_PERSONAL_API_KEY: z.string().optional().default(''),
  POSTHOG_HOST: z.string().optional().default('https://us.posthog.com'),
  // Ingestion (project) key for the dedicated "Gateway Ops" PostHog project (id 493944),
  // used only by src/telemetry/gateway-ops.ts to emit gateway OPS events (governance
  // would-deny, per-call LLM cost). Empty => telemetry is inert (no events emitted).
  POSTHOG_GATEWAYOPS_KEY: z.string().optional().default(''),
  DEPOT_TOKEN: z.string().optional().default(''),

  // Connectors wired in P3 wave 3 (read-only): GitHub App (reads) + Twilio (reads; sends are TCPA-gated, not wired)
  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_APP_INSTALLATION_ID: z.string().optional().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  // Twilio default sender (E.164) for outbound SMS/MMS/voice write tools. Callers may override per-call.
  TWILIO_FROM_NUMBER: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        `Check .env against .env.example, or refer to Matt's Notion Token Vault.`,
    );
  }
  cached = parsed.data;
  return cached;
}
