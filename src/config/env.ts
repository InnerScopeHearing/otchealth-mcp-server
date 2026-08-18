import { z } from 'zod';

const EnvSchema = z.object({
  // Customer.io
  CIO_SITE_ID: z.string().min(1, 'CIO_SITE_ID is required'),
  CIO_TRACK_KEY: z.string().min(1, 'CIO_TRACK_KEY is required'),
  CIO_APP_API_BEARER: z.string().min(1, 'CIO_APP_API_BEARER is required'),
  // Customer.io Journeys UI API / Design Studio control plane. Long-lived service-account token
  // exchanged at runtime for a one-hour JWT; inert when unset so the existing App/Track surface
  // remains boot-compatible until the least-privilege Customer.io role is provisioned.
  CIO_FLY_SERVICE_ACCOUNT_TOKEN: z
    .string()
    .optional()
    .default('')
    .refine(
      (value) => value === '' || value.startsWith('sa_live_') || value.startsWith('sa_sandbox_'),
      'CIO_FLY_SERVICE_ACCOUNT_TOKEN must be a Customer.io sa_live_ or sa_sandbox_ token',
    ),

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

  // Long-lived token for the 'otchealth-dev' GitHub Copilot CUSTOM AGENT's MCP header
  // (.github-private/agents/otchealth-dev.agent.md, target: github-copilot, tools: ["*"]).
  // Maps to caller_agent='developer' -- the SAME lane the Hyperagent "OTCHealth Gateway (Developer)"
  // skill and the M365 declarative Developer agent (M365_DEVELOPER_MCP_TOKEN below) already reach.
  // Deliberately a DISTINCT token from COPILOT_AGENT_TOKEN (2026-07-26): otchealth-dev is a
  // user-invocable custom agent with a real app-build job, a different trust profile than GitHub's
  // fully-autonomous issue-assignment coding agent, which correctly stays on COPILOT_AGENT_TOKEN's
  // low-privilege lane. Also distinct from M365_DEVELOPER_MCP_TOKEN so each front door's token can be
  // rotated independently (this file's existing convention -- see the M365 static tokens below).
  // Inert when unset. Rotate-before-launch.
  COPILOT_DEV_AGENT_TOKEN: z.string().optional().default(''),

  // Long-lived token for the M365 declarative Developer agent's native MCP runtime
  // (ai-plugin.json "RemoteMCPServer", auth type "None"). See auth/bearer.ts's extractQueryToken
  // for why this travels as a ?m365_dev_token= query-string value baked into the published
  // manifest's spec.url, not a real Authorization header — ApiKeyPluginVault is not supported for
  // MCP plugins and OAuthPluginVault requires a Teams Developer Portal UI step with no API/CLI
  // path, so this is the only fully non-interactive option (confirmed via research 2026-07-25).
  // Maps to caller_agent='developer' — the SAME lane the Hyperagent "OTCHealth Gateway (Developer)"
  // skill already uses via OAuth client_credentials; this is a second front door to that lane, not
  // a new/wider privilege grant. Inert when unset. Rotate-before-launch (rotation = replace this
  // secret + republish the app package via the same Graph appCatalogs/teamsApps call already used
  // to publish it).
  M365_DEVELOPER_MCP_TOKEN: z.string().optional().default(''),

  // Fleet-wide extension of the SAME auth:none + query-string-token pattern above (2026-07-25
  // deep-research fix), one static token per remaining fleet lane's own M365 declarative agent
  // RemoteMCPServer runtime. Each maps to that lane's existing caller_agent identity via
  // auth/bearer.ts's m365StaticAgentTokens() map — a second non-interactive front door to the
  // SAME lane the Hyperagent "OTCHealth Gateway (<Role>)" skill already reaches via OAuth
  // client_credentials, not a new/wider privilege grant. All inert when unset; all
  // rotate-before-launch (rotation = replace the secret + republish that agent's app package).
  M365_CTO_MCP_TOKEN: z.string().optional().default(''),
  M365_CFO_MCP_TOKEN: z.string().optional().default(''),
  M365_CLO_MCP_TOKEN: z.string().optional().default(''),
  M365_COO_MCP_TOKEN: z.string().optional().default(''),
  M365_CRO_MCP_TOKEN: z.string().optional().default(''),

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

  // Microsoft Graph (Exec Fleet Microsoft Graph app; send/read-as multiple CS personas)
  GRAPH_TENANT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_SECRET: z.string().optional().default(''),
  GRAPH_SENDER_EMAIL: z.string().optional().default('coo@otchealthmart.com'),
  // Allowlist of mailboxes the graph_* mail tools (send/list/get/mark-read) are permitted to touch
  // (see graph/api-client.ts's allowedMailboxes() header for why this exists: the app's application
  // permissions -- Mail.ReadWrite, Mail.Send, etc. -- are tenant-wide by default with no Graph-level
  // way to scope them; this is a code-level guard running in front of the real Exchange
  // ApplicationAccessPolicy, live since 2026-07-26 and confirmed enforcing via
  // Test-ApplicationAccessPolicy, added 2026-07-25 for the CRO customer-service-engine handoff).
  // CSV, case-insensitive. Defaults to the 5 known CS personas.
  GRAPH_CS_MAILBOXES: z.string().optional().default('care@otchealthmart.com,sarah@otchealthmart.com,helen@otchealthmart.com,ray@otchealthmart.com,coo@otchealthmart.com'),

  // Executive-lane READ-ONLY mailbox allowlist (2026-08-04, CFO FY2021-close regression fix).
  // graph_list_messages/graph_message_get resolve mailboxes on THIS list through a SEPARATE app --
  // the already-deployed otchealth-mail-readonly registration (reusing MAIL_ARCHIVE_EWS_CLIENT_ID/
  // SECRET/TENANT_ID below, its Graph-permissions grant, distinct from its EWS role) -- instead of
  // the CS-restricted GRAPH_CLIENT_ID app. Empirically confirmed 2026-08-04 that this app is NOT
  // subject to the CS-Engine-Mailboxes ApplicationAccessPolicy (live HTTP 200 direct-Graph reads
  // against every mailbox in the default list below). Gated to EXEC_RING callers only (see
  // isExecMailboxRequest()); the CS allowlist/app/policy above is completely untouched by this --
  // customer-service mailboxes and personas keep working exactly as before. READ ONLY: send/write
  // stay on the CS-only path. CSV, case-insensitive, env-overridable.
  GRAPH_EXEC_MAILBOXES: z.string().optional().default('matthew@innd.com,ap@innd.com,accounting@hearingassist.com,cfo@innd.com'),

  // Repo-scoping allowlist for github_*/depot_* READ tools, for non-cto/exec callers (2026-07-26,
  // hardening follow-up to the otchealth-dev Copilot custom agent wiring -- see
  // github/api-client.ts's assertRepoAllowed() header for the full rationale). CSV of "owner/repo"
  // pairs, case-insensitive. DEFAULT (unset/empty) IS UNRESTRICTED -- Matt's explicit call,
  // 2026-07-26: ships as a zero-risk, inert control point, not a live restriction today. cto/exec
  // are never subject to this check regardless of its value.
  DEVELOPER_ALLOWED_REPOS: z.string().optional().default(''),

  // Stripe (read-only)
  STRIPE_SECRET_KEY: z.string().optional().default(''),

  // Xero (accounting of record; QuickBooks RETIRED 2026-07-16). READ-ONLY tools, executive-ring
  // gated (MNPI). One Xero app; per-org BOOTSTRAP refresh tokens — Xero rotates refresh tokens on
  // every use, so after first use the live chain is maintained in Cosmos (tools/xero/client.ts)
  // and these env secrets are only re-read when their value CHANGES (operator re-consent).
  XERO_CLIENT_ID: z.string().optional().default(''),
  XERO_CLIENT_SECRET: z.string().optional().default(''),
  XERO_RT_OTCHEALTH: z.string().optional().default(''),
  XERO_RT_INND: z.string().optional().default(''),
  XERO_RT_HEARINGASSIST: z.string().optional().default(''),
  XERO_RT_PERSONAL: z.string().optional().default(''),
  // Optional tenantId pins (else tenant resolves via /connections + name heuristics).
  XERO_TENANT_OTCHEALTH: z.string().optional().default(''),
  XERO_TENANT_INND: z.string().optional().default(''),
  XERO_TENANT_HEARINGASSIST: z.string().optional().default(''),
  XERO_TENANT_PERSONAL: z.string().optional().default(''),

  // Mail archive (TEMPORARY — see tools/mail/client.ts header). EWS app-only client_credentials
  // against the Office 365 Exchange Online resource, reusing the otchealth-mail-readonly app
  // registration's client id/secret/tenant (a distinct EWS-resource app-role grant, separate from
  // its Graph permissions). Single hardcoded target mailbox (default matthew@innd.com). Bridges the
  // CFO agent to the Online Archive mailbox until this is replaced ahead of the EWS shutdown
  // (phased disable 2026-10-01, full shutdown 2027-04-01).
  MAIL_ARCHIVE_EWS_CLIENT_ID: z.string().optional().default(''),
  MAIL_ARCHIVE_EWS_CLIENT_SECRET: z.string().optional().default(''),
  MAIL_ARCHIVE_EWS_TENANT_ID: z.string().optional().default(''),
  MAIL_ARCHIVE_MAILBOX: z.string().optional().default('matthew@innd.com'),

  // OAuth 2.1 (confidential client). When OAUTH_CLIENT_ID + OAUTH_TOKEN_SIGNING_SECRET are set,
  // the gateway issues real expiring JWT access/refresh tokens (PKCE S256 mandatory). When unset,
  // the legacy static-connector-token behavior is preserved for back-compat.
  OAUTH_CLIENT_ID: z.string().optional().default(''),
  OAUTH_CLIENT_SECRET: z.string().optional().default(''),
  OAUTH_TOKEN_SIGNING_SECRET: z.string().optional().default(''),
  OAUTH_REDIRECT_URIS: z.string().optional().default(''),
  PUBLIC_BASE_URL: z.string().optional().default(''),
  // client_credentials (machine-to-machine) access-token lifetime, in seconds. The M2M lane tokens
  // (e.g. the Claude Code gateway-connect hook) carry NO refresh token, so a long-running turn that
  // outlives a 1h token 401s mid-turn until the next prompt re-mints. These tokens are lane-scoped,
  // revocable, and re-minted every prompt, so a longer lifetime is a safe mid-turn margin, not new
  // exposure. Default 24h (operator-chosen 2026-07-16) covers any autonomous turn; tune without a
  // redeploy. The human authorization_code/refresh path is deliberately left at 1h (it has silent
  // refresh). Bounded 60s..24h so a typo cannot mint an effectively-permanent token.
  OAUTH_CC_TTL_SECONDS: z
    .string()
    .default('86400')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n >= 60 && n <= 86400, 'OAUTH_CC_TTL_SECONDS must be 60..86400'),
  // Refresh-token lifetime, in seconds, for the human authorization_code/refresh path (the Claude Chat
  // executive connectors). The refresh token rotates on every use, so an actively-used connector renews
  // itself forever; this ceiling only bites a connector left IDLE past it, which then needs a manual
  // reconnect. Default 90d (was a hardcoded 30d) so executives reconnect far less often. Bounded
  // 1 day..1 year. Does not affect the access-token lifetime (still 1h; silent refresh covers it).
  OAUTH_REFRESH_TTL_SECONDS: z
    .string()
    .default('7776000')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n >= 86400 && n <= 31536000, 'OAUTH_REFRESH_TTL_SECONDS must be 86400..31536000'),
  // Per-agent OAuth clients (P2b): JSON array [{"client_id":"..","secret":"..","agent":"developer"}].
  // Each connecting client maps to an agent lane; the issued token carries that agent identity.
  OAUTH_CLIENTS: z.string().optional().default(''),
  // Agent identity for the single OAUTH_CLIENT_ID connection (the original Hyperagent CTO connector).
  OAUTH_DEFAULT_AGENT: z.string().optional().default(''),
  // DEPRECATED / NO-OP as of the Phase 6 connector-ring closure (2026-07-15): public self-registered
  // DCR (Claude connector) clients are now hard-bound to the non-privileged 'external-read' lane in
  // server/oauth.ts regardless of connector name, so this override is no longer consumed by any code.
  // Kept in the schema so an existing deployment that still sets it does not fail env validation.
  OAUTH_DCR_DEFAULT_AGENT: z.string().optional().default(''),
  // Curated csv toolset advertised to Claude Chat DCR connector clients whose lane is a SHIP lane
  // (cto/developer/EXEC_RING; empty -> built-in default CTO_SHIP_LANE_TOOLSET, tools/registry.ts).
  CONNECTOR_TOOLSET: z.string().optional().default(''),
  // Curated csv toolset advertised to every OTHER connector lane (an unrecognized/self-named
  // connector, an empty caller lane, or any lane not in the ship set; empty -> built-in default
  // EXTERNAL_READONLY_TOOLSET, tools/registry.ts). SECURITY-CRITICAL: this is what an external,
  // unauthorized connector sees -- keep it a minimal, non-privileged read set. See
  // tools/registry.connector-lanes.test.ts.
  EXTERNAL_READONLY_TOOLSET: z.string().optional().default(''),

  // PER-LANE TOOL-CATALOG CURATION for INTERNAL client_credentials lanes (Wave 6 item 6.2,
  // src/safety/tool-catalog-curation.ts + src/config/lane-toolsets.ts). Extends the SAME idea as
  // CONNECTOR_TOOLSET / EXTERNAL_READONLY_TOOLSET above to cto/cfo/clo/clo-personal/coo/cro/cpo/cco/
  // developer/exec, which today always see the full ~850-tool catalog (isConnectorSurface() is only
  // ever true for a dcr_/occ_ client id, never a client_credentials lane). Also NOT in this schema on
  // purpose, same reasoning as SHIELD_MODE/COLD_START_MODE/JIT_DOCTRINE_MODE above -- read fresh from
  // process.env per call so it can be flipped without a redeploy:
  //   TOOL_CATALOG_CURATION_MODE  off | report (DEFAULT) | curate | curate-m365-only
  // 'report' (the default) NEVER restricts what any lane sees -- every internal lane keeps getting the
  // full catalog exactly as before this feature shipped. It only fires a fire-and-forget
  // gw_lane_tool_used telemetry event per actual tool call (via the existing captureGatewayEvent /
  // POSTHOG_GATEWAYOPS_KEY pattern), annotated against that lane's SEED allowlist in
  // config/lane-toolsets.ts, so a real usage picture can build before anyone commits to curating
  // anything. 'curate' is the non-default opt-in that actually narrows a known internal lane's
  // advertised tools/list response to its seed allowlist (registry.ts's registerTool early-returns
  // before registering a tool outside the list -- mirrors the pre-existing connector-surface early
  // return just above it), for EVERY caller on that lane. 'curate-m365-only' (the mode currently
  // deployed) applies that SAME narrowing, but ONLY to a request that authenticated via an M365
  // declarative-agent static token, OR whose lane is named in TOOL_CATALOG_CURATE_LANES below -- a
  // plain client_credentials session (Claude Code, Hyperagent) on any other lane is left fully
  // uncurated by design (see tool-catalog-curation.ts's header for why, and for the "coo's tools/list
  // is small, cro's is not" finding this does NOT explain by itself -- that disparity is a different,
  // unconditional mechanism, EXTERNAL_READONLY_TOOLSET below, not this mode). 'off' silences the
  // telemetry too (a no-op). An unrecognized lane (not in KNOWN_INTERNAL_LANES) is NEVER curated or
  // logged in any mode -- fail-open by construction, see tool-catalog-curation.ts's header.
  // Execution-time ring/role gating (kb/search-privileged.ts, catalog/governance.ts) is completely
  // UNCHANGED by this feature either way; this only controls what appears in a tools/list response,
  // never what a call is authorized to do.
  //   TOOL_CATALOG_CURATE_LANES  csv of KNOWN_INTERNAL_LANE names (e.g. "cro"), default EMPTY
  // Only consulted under curate-m365-only: opts a specific lane into that mode's narrowing even for a
  // non-M365 caller, without widening curation to every lane the way flipping to plain 'curate' would.
  // See tool-catalog-curation.ts's header before arming a lane here -- review that lane's real
  // gw_lane_tool_used usage against its seed allowlist first, the same discipline 'curate' itself
  // expects.

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

  // SEARCH BACKEND SWITCH (src/search/index.ts dispatcher). Default 'azure' is BYTE-IDENTICAL to
  // every deploy before this variable existed: every dispatched caller keeps calling
  // src/azure/search.ts exactly as before. Flip to 'opensearch' to route those same callers at
  // Amazon OpenSearch instead (src/search/opensearch.ts).
  //
  // CORRECTED 2026-08-15: this comment previously said kb_search_privileged was "DELIBERATELY NOT
  // wired to this dispatcher and always uses Azure regardless of this value". That is no longer
  // true -- src/tools/kb/search-privileged.ts imports the dispatcher and therefore honours this
  // variable like every other caller (see src/search/index.ts's header for why the repoint is
  // ring-NEUTRAL: isLaneAllowed runs BEFORE the search call and depends only on index + caller).
  // Leaving the stale text would have told a cutover reader that the privileged legal/finance rooms
  // stay on Azure when they do not, which is exactly the belief that gets a ring boundary
  // misjudged during a migration.
  SEARCH_BACKEND: z.enum(['azure', 'opensearch']).default('azure'),

  // Where query embeddings come from (src/azure/foundry.ts embeddingsTarget). Vector search embeds
  // every query, so while this points at Azure the brain cannot outlive an Azure suspension no
  // matter where search or the documents live.
  //   foundry (default)  Azure Foundry. Byte-identical to every prior deploy.
  //   openai             api.openai.com, using OPENAI_API_KEY.
  // The MODEL is pinned to text-embedding-3-large on both paths and is NOT configurable: the
  // OpenSearch index's 492k vectors were built with it, and query vectors from any other model are
  // not comparable to them. That failure is silent -- relevance collapses, nothing errors -- and
  // the only repair is re-embedding every document. It is also exactly why the AWS-native choice
  // (Bedrock Titan/Cohere) is the WRONG one here despite the destination being AWS.
  EMBEDDINGS_PROVIDER: z.enum(['foundry', 'openai']).default('foundry'),
  OPENAI_API_KEY: z.string().optional().default(''),

  // WHICH PROVIDER SERVES CHAT COMPLETIONS (src/azure/foundry.ts chatTarget()). Mirrors
  // EMBEDDINGS_PROVIDER's shape exactly, but is a SEPARATE flag: the embeddings model is pinned
  // (any provider must return the identical text-embedding-3-large vector space or the 492k-doc
  // index silently stops matching), while chat has no such constraint -- a different provider can
  // legitimately answer with a different underlying model, so this is free to move independently
  // of EMBEDDINGS_PROVIDER (e.g. embeddings could stay on Foundry while chat moves to OpenAI, or
  // vice versa, during a staged cutover).
  //   foundry (default)  Azure Foundry (FOUNDRY_CHAT_DEPLOYMENT/FOUNDRY_HIGH_DEPLOYMENT/
  //                       FOUNDRY_ROUTER_*). Byte-identical to every prior deploy.
  //   openai              api.openai.com, using OPENAI_API_KEY. See OPENAI_CHAT_MODEL/
  //                       OPENAI_HIGH_MODEL/OPENAI_ROUTER_MODEL below for the tier -> model id
  //                       mapping and why those defaults are a JUDGEMENT CALL, not a verified fact.
  LLM_PROVIDER: z.enum(['foundry', 'openai']).default('foundry'),
  // Tier -> OpenAI-direct model id overrides for the LLM_PROVIDER=openai path (src/azure/foundry.ts
  // openaiModelForTier()). FOUNDRY_CHAT_DEPLOYMENT/FOUNDRY_HIGH_DEPLOYMENT ('gpt-5.1'/'gpt-5.4') are
  // AZURE DEPLOYMENT NAMES -- an operator-chosen alias, not necessarily a real, callable
  // api.openai.com model id. Unlike EMBEDDINGS_PROVIDER's model (verified byte-identical across both
  // providers 2026-08-15), there is no equivalent live verification for chat here. Defaulting these
  // to the SAME strings as the Foundry deployment names is a bet that the operator named the Azure
  // deployment after its real underlying model (a common, not universal, Azure OpenAI convention).
  // If the bet is wrong, api.openai.com returns a fast, loud 404 model_not_found -- never a silent
  // wrong-model answer -- so the failure mode is safe even when the default guess is wrong. Set
  // these the moment the real ids are confirmed; do not treat the defaults as verified fact.
  OPENAI_CHAT_MODEL: z.string().optional().default(''),
  OPENAI_HIGH_MODEL: z.string().optional().default(''),
  // tier:'router' (Azure Model Router, an auto-pick-the-cheapest-sufficient-model PRODUCT) has NO
  // documented api.openai.com counterpart. Rather than invent one, an unset OPENAI_ROUTER_MODEL
  // makes tier:'router' fall back to the SAME model as tier:'standard' on the OpenAI path -- the
  // identical fallback chat() already performs today when FOUNDRY_ROUTER_ENDPOINT/KEY are unset, so
  // LLM_PROVIDER=openai simply behaves as if the router were permanently unconfigured. Set this only
  // if a real OpenAI routing model id is confirmed later.
  OPENAI_ROUTER_MODEL: z.string().optional().default(''),

  // WEB SEARCH PROVIDER SWITCH (src/tools/web/web-search.ts dispatcher, Wave A item A5,
  // runbooks/azure-full-retirement.md). Mirrors SEARCH_BACKEND / BLOB_BACKEND / EMBEDDINGS_PROVIDER's
  // shape exactly, but closes a DIFFERENT class of gap than those three: web_search had NO dispatcher,
  // NO env flag, and NO fallback branch of any kind before this -- it called Azure AI Foundry
  // (Grounding-with-Bing) directly, Azure-only BY CONSTRUCTION, unlike every other Azure dependency in
  // this gateway (which at least had a single-provider function that could be branched). Used by every
  // agent's ground-first protocol for external/public-world queries, so going dark on an Azure
  // suspension was a fleet-wide capability loss, not a degraded corner.
  //
  //   azure (default)  Azure AI Foundry project + Grounding-with-Bing (WEBSEARCH_SP_TENANT_ID/
  //                     CLIENT_ID/SECRET/PROJECT_ENDPOINT/MODEL, still read directly from process.env
  //                     in src/tools/web/providers/azure-web-search.ts, NOT through this schema --
  //                     preserves the file's original "self-contained, touches nothing else" property
  //                     for this one provider, since it predates this dispatcher and its behavior must
  //                     stay byte-identical). Default is a pure passthrough: every caller keeps hitting
  //                     the exact same Azure endpoint exactly as before this flag existed.
  //   tavily            Tavily's Search API (api.tavily.com/search, TAVILY_API_KEY below), the chosen
  //                     Azure-exit replacement -- see src/tools/web/providers/tavily-web-search.ts's
  //                     header for why Tavily over Brave/Serper/Exa/Bedrock (short version: Amazon
  //                     Bedrock does not support Anthropic's web_search server tool AT ALL -- confirmed
  //                     live against platform.claude.com/docs 2026-08-16 -- and the one AWS-billed
  //                     product that does, "Claude Platform on AWS", needs a brand-new AWS Marketplace
  //                     subscription plus a fully separate Anthropic organization, disproportionate to
  //                     replacing one read-only tool; Tavily's `include_answer` returns a synthesized
  //                     answer AND source citations in the SAME call at the SAME per-credit price as a
  //                     plain search, the closest functional match to what Grounding-with-Bing did).
  //
  // FAILURE MODE: exactly like every provider path in this file, an unconfigured active provider
  // returns a clearly-labeled {mode:'unconfigured'} result (never a silent empty {mode:'web'} that
  // reads as "searched and found nothing" -- that specific silent-empty-success shape is a failure
  // class this fleet has hit before). A request/network failure returns {mode:'error', error:<msg>}.
  // Neither ever throws out of the tool handler.
  WEB_SEARCH_PROVIDER: z.enum(['azure', 'tavily']).default('azure'),
  // Tavily API key (dashboard at https://app.tavily.com, prefixed `tvly-`). SIGNUP STEP (human,
  // one-time, no AWS/Azure involvement): create a free Tavily account at https://www.tavily.com or
  // directly at https://app.tavily.com (no credit card required for the free tier -- 1,000
  // credits/month, verified 2026-08-16 at tavily.com/pricing), copy the API key shown on the
  // dashboard's main page, store it as this secret. PRICING (verified 2026-08-16,
  // docs.tavily.com/documentation/api-credits + tavily.com/pricing): pay-as-you-go $0.008/credit, a
  // basic search costs 1 credit and `include_answer` adds NO extra credits, so this is $0.008/query
  // flat once past the free 1,000/month; a $30/mo plan bundles 4,000 credits/mo (~$0.0075/credit
  // effective) if usage grows past the free tier. At any realistic volume for an internal agent
  // research tool (dozens to low hundreds of queries/day across the whole fleet, not a customer-facing
  // feature), this stays inside the free tier or low single-digit dollars/month -- trivial against the
  // ~$362/mo of headroom under the $625/mo AWS spend ceiling (~$263/mo current run rate), and it is
  // not even AWS spend: Tavily is a third-party SaaS vendor, billed independently of the AWS account,
  // same as Brave/Serper/Exa would be. Inert (WEB_SEARCH_PROVIDER=tavily resolves to
  // {mode:'unconfigured'}) until this is set. Rotate-before-launch.
  TAVILY_API_KEY: z
    .string()
    .optional()
    .default('')
    .refine((value) => value === '' || value.startsWith('tvly-'), 'TAVILY_API_KEY must be a Tavily tvly- key'),

  // Which store serves DOCUMENT reads (kb_get_document, legal_blob_get, _TEXT sidecars).
  //   azure (default)  Azure Blob, via src/legal/blob-store.ts. Byte-identical to every prior deploy.
  //   s3               the S3 mirror, via src/legal/s3-blob-store.ts.
  // Search finding a document is useless if its CONTENTS still come from Azure -- that is what kept
  // the gateway Azure-dependent after the search backend moved. Flipping this is what actually
  // removes the dependency. Reads only; document WRITES continue to go to Azure (the mirror has no
  // reconciliation path, so writing to it directly would silently diverge it from the source).
  BLOB_BACKEND: z.enum(['azure', 's3']).default('azure'),

  // Which store holds the AGENT STATE PLANE: the work-ledger (tasks), the memory-of-record
  // (memory), the transition log (events), OAuth codes/tokens, the LLM/FAQ caches, AND (as of
  // src/agentstate/queue.ts's dispatcher) the agent inbox (agent_dispatch / inbox_read / wake).
  //   cosmos (default)  Azure Cosmos DB + Azure Storage Queues, via src/agentstate/cosmos.ts and
  //                     src/agentstate/queue-azure.ts. Byte-identical to prior deploys.
  //   postgres          RDS Postgres for both, via src/agentstate/postgres.ts (documents) and
  //                     src/agentstate/queue-postgres.ts (the inbox, its own table + atomic
  //                     claim -- see that file's header for why it is not just another
  //                     postgres.ts container).
  //
  // This is the LAST Azure runtime dependency and the one with the worst failure mode. Search and
  // documents degrade to "cannot read" if Azure goes away; state degrades to "cannot WRITE" --
  // writeMemory() and memory-write.ts both await their create with no catch, so an Azure
  // suspension does not make the fleet forgetful, it makes it unable to record anything at all --
  // and before queue-postgres.ts existed, the inbox call sites called Azure UNCONDITIONALLY,
  // ignoring this flag entirely, so agent-to-agent dispatch would have stopped outright.
  // Consumers must therefore import from src/agentstate/store.ts (documents) or
  // src/agentstate/queue.ts (the inbox) -- the two dispatchers -- never from cosmos.ts,
  // postgres.ts, queue-azure.ts, or queue-postgres.ts directly;
  // agentstate-dependency-guard.test.ts enforces the document half in CI.
  STATE_BACKEND: z.enum(['cosmos', 'postgres']).default('cosmos'),

  // RDS Postgres connection for STATE_BACKEND=postgres. Inert unless PG_HOST is set, so a
  // deployment that never sets these behaves exactly as before this flag existed.
  // NOTE the instance is PubliclyAccessible=false by design: it is reachable only from inside the
  // VPC, which is why schema work runs as a Fargate task rather than from an operator shell.
  PG_HOST: z.string().optional().default(''),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DATABASE: z.string().optional().default('agentstate'),
  PG_USER: z.string().optional().default(''),
  PG_PASSWORD: z.string().optional().default(''),
  // RDS terminates TLS with an Amazon-issued cert. Verification needs the RDS CA bundle in the
  // image; until that is baked in, encrypt-without-verify is still strictly better than plaintext
  // and the traffic never leaves the VPC. Set true once the bundle ships.
  PG_SSL_VERIFY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Dual-write the memory index to BOTH backends (see src/search/index.ts indexMemory). Reads still
  // come from SEARCH_BACKEND alone; this only widens WRITES. Turn ON before flipping reads so the
  // cutover has no lossy instant, and OFF only once the old backend is retired. Default false =
  // byte-identical to the single-backend behavior that existed before dual-write.
  SEARCH_DUAL_WRITE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Kill-switch for the search-mode telemetry emitted by the dispatcher (src/search/index.ts).
  // 'on' (default) emits one fire-and-forget gw_search_mode event per room query carrying ONLY the
  // backend, room name, degraded flag and hit count -- never the query text or any hit content.
  // This exists because hybrid search fails OPEN: src/search/opensearch.ts catches an embed()
  // failure and continues keyword-only, so losing Azure Foundry (which still serves embeddings even
  // after the OpenSearch cutover) silently halves retrieval quality while every health check stays
  // green. The keyword/hybrid ratio is the only signal that distinguishes that from normal
  // operation. Set to 'off' to disable emission entirely.
  SEARCH_MODE_TELEMETRY: z.enum(['on', 'off']).default('on'),

  // Amazon OpenSearch (SigV4-signed, service 'es'), the alternate backend behind
  // SEARCH_BACKEND=opensearch. Inert (searchConfigured() -> false) unless OPENSEARCH_ENDPOINT is
  // set. Endpoint is the domain HOST ONLY, no scheme (e.g.
  // "search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com") -- HTTPS is
  // always assumed. Credentials resolve in this order: (1) AWS_ACCESS_KEY_ID +
  // AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN) when both are set; (2) the ECS task-role
  // container credential endpoint (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, set automatically by
  // the ECS agent -- no explicit env var needed here beyond what ECS already injects). Neither
  // path pulls in the aws-sdk (this repo intentionally carries none); see src/search/sigv4.ts.
  OPENSEARCH_ENDPOINT: z.string().optional().default(''),
  OPENSEARCH_REGION: z.string().optional().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
  AWS_SESSION_TOKEN: z.string().optional().default(''),

  // Kill-switch for the memory-room authority+freshness re-rank (src/memory/authority-rerank.ts).
  // Default ON. Set to 'off' to fall back to pure relevance order (byte-identical to pre-Wave-1).
  MEMORY_RERANK_MODE: z.string().optional().default('on'),

  // Auto-supersession at write (src/memory/auto-supersede*.ts, Wave 1 W1-2). Graduated rollout:
  //   off     -> detection skipped entirely (DEFAULT: ship the write-path change DARK, zero runtime
  //              change, so the deploy is a true no-op on the memory-of-record).
  //   suggest -> detect a contradiction with a near-prior same-agent entry + emit a reconcile beacon,
  //              but do NOT link supersedes (watch the beacons + latency before trusting it).
  //   auto    -> additionally link supersedes so the contradicted belief retires with no agent
  //              discipline. Flip here only AFTER the golden-recall suite proves the classifier's
  //              precision (a false positive would silently retire a TRUE belief). Fail-open always.
  MEMORY_AUTOSUPERSEDE_MODE: z.string().optional().default('off'),

  // Kill-switch for the deterministic current-value entity lookup in brain_search (Wave 1 W1-3,
  // src/memory/entity-lookup.ts). Default ON: a query that resolves to a known typed-entity key gets
  // that key's CURRENT value promoted ahead of the semantic top-k. Set 'off' for pure semantic recall.
  ENTITY_LOOKUP_MODE: z.string().optional().default('on'),

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

  // Hyperagent broker. ONE account-wide delegated credential, brokered per lane by
  // src/tools/hyperagent/ring.ts, because Hyperagent's own MCP has no per-agent authorization
  // ("a connected client ... can only reach the agents you can") and no client_credentials grant,
  // so a server cannot self-authenticate and per-agent connections would be N keys to one building.
  HYPERAGENT_CLIENT_ID: z.string().optional().default(''),
  HYPERAGENT_CLIENT_SECRET: z.string().optional().default(''),
  // Captured once from a browser consent with the offline_access scope. Same shape as the OneDrive
  // delegated token. If the provider rotates it on use, client.ts warns loudly (see rotationPending).
  HYPERAGENT_REFRESH_TOKEN: z.string().optional().default(''),
  // Allowlist: 'lane=agentId,agentId;lane=agentId'. A lane absent here reaches NOTHING.
  HYPERAGENT_LANE_AGENTS: z.string().optional().default(''),
  // Classification: 'agentId=personal-legal|exec|general;...'. An agent absent here is `unknown`,
  // which every lane is refused — deny-by-default, because the real agent ids live on Matt's
  // account and guessing toward permissive is how a privileged thread leaks.
  HYPERAGENT_AGENT_CLASSES: z.string().optional().default(''),

  // Phase 3: Netlify (INND site + portfolio deploy visibility, read-only)
  NETLIFY_AUTH_TOKEN: z.string().optional().default(''),

  // Phase 3: Gumroad (digital-products cash lane scoreboard, read-only)
  GUMROAD_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 4: kb-memory shared brain (commons store ONLY; non-PHI, non-MNPI, non-privileged
  // by construction). Inert without these. Mirrors skills/kb-memory commons (otchealthcommons /
  // company-journal). NEVER wire the cfo/clo/clo-personal/PHI storage accounts here.
  AZURE_COMMONS_STORAGE_ACCOUNT: z.string().optional().default(''),
  AZURE_COMMONS_STORAGE_KEY: z.string().optional().default(''),

  // HeyGen production-control feature gates. Every provider mutation family is independently dark by
  // default; read/status tools and dry-run preflight remain available. The fleet-wide provider-write
  // interlock AND the exact family flag must both be true before any credit-consuming provider call.
  // The owner approval public key is verification-only and may be empty while writes remain false.
  ENABLE_HEYGEN_PROVIDER_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_PROMPT_AVATAR_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_AVATAR_VIDEO_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_REFERENCE_LOOK_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_VIDEO_AGENT_GENERATION: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_ASSET_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_TRANSLATION_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_TTS_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ENABLE_HEYGEN_METADATA_WRITES: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  HEYGEN_OWNER_APPROVAL_ISSUER: z.string().optional().default('https://approval.otchealth.app'),
  HEYGEN_OWNER_APPROVAL_AUDIENCE: z.string().optional().default('otchealth-heygen'),
  HEYGEN_OWNER_APPROVAL_SUBJECT: z.string().optional().default(''),
  HEYGEN_OWNER_APPROVAL_PUBLIC_JWK: z.string().optional().default(''),
  HEYGEN_OWNER_APPROVAL_PRIVATE_JWK: z.string().optional().default(''),
  HEYGEN_OWNER_APPROVAL_EMAIL: z.string().optional().default('').refine(
    (value) => value === '' || z.string().email().safeParse(value).success,
    'HEYGEN_OWNER_APPROVAL_EMAIL must be a valid email when configured',
  ),
  HEYGEN_APPROVAL_CONTEXT_SECRET: z.string().optional().default(''),
  HEYGEN_APPROVAL_HANDLE_SECRET: z.string().optional().default(''),
  HEYGEN_APPROVAL_CALLBACK_SECRET: z.string().optional().default(''),
  HEYGEN_APPROVAL_BROKER_URL: z.string().optional().default('').refine(
    (value) => value === '' || z.string().url().safeParse(value).success,
    'HEYGEN_APPROVAL_BROKER_URL must be a valid URL when configured',
  ),
  HEYGEN_APPROVAL_CALLBACK_URL: z.string().url().optional().default('https://mcp.otchealth.app/heygen/approval/callback'),

  // Agent State Plane - Cosmos DB for NoSQL work-ledger + structured memory-of-record.
  // Inert without COSMOS_ENDPOINT/COSMOS_KEY. Non-PHI, non-MNPI, non-privileged by construction
  // (the clo-personal lane is rejected). Verbatim-critical records live here, never in an
  // LLM-consolidated store.
  COSMOS_ENDPOINT: z.string().optional().default(''),
  COSMOS_KEY: z.string().optional().default(''),
  COSMOS_DB: z.string().optional().default('agent-state'),
  // Auth mode for the Cosmos data-plane client (src/agentstate/cosmos.ts). 'key' (default) is
  // TODAY'S behavior byte-for-byte: master-key HMAC auth via COSMOS_KEY. 'aad' switches to an
  // Azure AD bearer token minted from the gateway Container App's managed identity (granted
  // "Cosmos DB Built-in Data Contributor" on the account) -- the Phase 6 migration off the Cosmos
  // master key, a prerequisite to later disabling local (key) auth on the account. Purely
  // additive: this var unset (or explicitly 'key') means ZERO change to any deployed behavior.
  // See cosmos.ts's file header for the aad Authorization header format + the Microsoft-docs
  // citation for it.
  COSMOS_AUTH_MODE: z.enum(['key', 'aad']).default('key'),

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
  // Protected prefixes for legal_blob_delete/legal_blob_move (2026-08-04, CLO brief §1): a delete
  // or a move-away-from-here is refused outright, regardless of caller/dry_run, when the SOURCE
  // path falls under one of these prefixes. The court-download folder and any raw filings tree are
  // evidence and stay append-only no matter what any agent asks -- this is a second, independent
  // control from the soft-delete-to-_TRASH mechanism (both must be defeated to lose a document).
  // Prefix match is case-sensitive (Azure blob names are case-sensitive); CSV, env-overridable.
  LEGAL_PROTECTED_PREFIXES: z
    .string()
    .optional()
    .default('clo-outgoing/Divorce Case Summary and ALL Filings/,filings/'),
  // Soft time budget for legal_blob_delete's bulk (prefix) mode, in milliseconds (2026-08-04, CLO
  // field report Finding 1): 147 soft-deletes = 294 Azure ops (copy+remove each) at the CLO's
  // measured ~0.7s/item ran ~100s -- over the 60s MCP transport timeout, with the caller left unable
  // to tell whether the call had done nothing, some, or all of the batch (it HAD completed
  // server-side; the client just never learned that). The bulk loop checks elapsed time BEFORE
  // starting each item and returns {status:'partial', remaining} well inside the transport ceiling
  // rather than risk an orphaned execution the caller can't observe. A partial result is naturally
  // resumable: re-invoking with the SAME prefix only re-matches what has not yet moved (moved items
  // are gone from the source prefix).
  //
  // BOUND TIGHTENED to 1s..35s, default 30s (2026-08-04, PR #191 review; was 1s..55s/45s): the
  // per-item budget check bounds how many items are STARTED, not how long the item already in
  // flight when the check last passed can run -- copyBlob's own async-copy poll loop has a hard 20s
  // ceiling (src/legal/blob-store.ts), so an item that starts just under the budget could still push
  // total elapsed close to budget+20s. The old 55s ceiling left almost no margin (55+20=75s, well
  // past the 60s transport timeout); the new ceiling guarantees at least 25s of headroom under 60s
  // even in that worst case (35+20=55s), while 30s default leaves 30s of headroom in normal
  // operation. A future fix could thread a real deadline through listing/copy/delete instead of only
  // checking between items; this bound is the cheap, low-risk mitigation until that lands.
  LEGAL_DELETE_TIME_BUDGET_MS: z
    .string()
    .default('30000')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n >= 1000 && n <= 35000, 'LEGAL_DELETE_TIME_BUDGET_MS must be 1000..35000'),

  // Finance dataroom store (the CFO source-docs blobs behind the finance-* AI Search rooms, account
  // otchealthcfodata). Powers kb_get_document — ring-gated WHOLE-document retrieval (search returns
  // snippets; an audit census must tie to the dollar, so the CFO needs complete files with provable
  // counts). Same SharedKey mechanics as the legal store. Inert without the key.
  AZURE_CFO_STORAGE_ACCOUNT: z.string().optional().default('otchealthcfodata'),
  AZURE_CFO_STORAGE_KEY: z.string().optional().default(''),

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
  //   SHIELD_MODE           off | report (default) | enforce, inbound Prompt Shields on tool args
  //   GROUNDEDNESS_MODE     off (default) | report | enforce, outbound groundedness on tools that surface a hint
  //   RETRIEVAL_SHIELD_MODE off | report (default) | enforce, Prompt Shields' document scan on retrieved
  //                         passages, run by src/memory/deep-retrieval.ts right before it concatenates them
  //                         into a synthesis prompt (the indirect-injection vector, a malicious instruction
  //                         hidden inside a retrieved document). enforce withholds only the synthesized
  //                         answer, never the raw retrieved passages. See auto-guard.ts's retrievalShield().
  // 'report' runs the check and annotates/logs but never blocks; 'enforce' blocks (inbound: pre-handler;
  // outbound: read-only tools only; retrieval: the synthesis step only). All fail-open + inert until
  // CONTENT_SAFETY_* above is set.

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
  // purpose, same reasoning as SHIELD_MODE/GROUNDEDNESS_MODE above — read fresh from process.env per call so it can
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
  //   CAPTURE_PRESSURE_THRESHOLD a positive integer (default 50)
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

  // DEEP RETRIEVAL MODE (Phase 4A, src/memory/deep-retrieval.ts). Also NOT in this schema on
  // purpose, same reasoning as COLD_START_MODE/JIT_DOCTRINE_MODE above -- read fresh from
  // process.env per call (in src/tools/kb/brain-search.ts's handler) so it can be flipped without
  // a redeploy:
  //   DEEP_RETRIEVAL_MODE  off | on (default)
  // Gates brain_search's mode:'deep' path. 'on' (the default) runs the full agentic pipeline (an
  // LLM query-plan -> multi-room, multi-subquery retrieval -> ONE bounded evaluate-refine round if
  // the pool looks thin -> a cited LLM synthesis). 'off' makes mode:'deep' behave EXACTLY like
  // mode:'fast' -- deepRetrieve() is not even called -- an instant, zero-extra-Foundry-cost rollback
  // if the agentic path misbehaves or Foundry capacity needs to be reserved for higher-priority
  // callers. deepRetrieve() is ALSO fail-open end to end regardless of this flag (see its own file
  // header): this switch is an operator kill-switch, not the only safety net.

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

  // OPENAI CONNECTOR CONTRACT (Phase 6, src/tools/kb/openai-search.ts + openai-fetch.ts). Also NOT
  // in this schema on purpose, same reasoning as INCIDENT_MATCH_MODE/DEEP_RETRIEVAL_MODE above --
  // read fresh from process.env per call so it can be flipped without a redeploy:
  //   OPENAI_SEARCH_MODE  off | on (default)
  // Gates the `search` + `fetch` tool pair (the fixed, no-prefix tool names the OpenAI ChatGPT /
  // Deep Research MCP connector contract requires). 'off' makes both tools return an inert,
  // clearly-labeled disabled response with no Azure Search call at all. This is a SHARED switch --
  // fetch.ts imports and reads the SAME parser search.ts exports, so the pair is one on/off unit,
  // never independently toggled (no fetch-without-search half state). Ring-safety (never a
  // privileged room; fetch re-derives + re-checks the room from the id on every call) is NOT gated
  // by this switch and cannot be turned off by it -- see those files' headers.

  // SHADOW EVAL (Wave 7 item 7.2, src/safety/shadow-eval.ts + src/azure/search.ts's hybridSearch).
  // THREE env flags, all NOT in this schema on purpose, same reasoning as COLD_START_MODE above --
  // read fresh from process.env per call so they can be flipped without a redeploy:
  //   SHADOW_EVAL_MODE          off (default) | on
  // 'off' is a complete no-op (the pre-existing hybridSearch code path, byte-identical). 'on' makes
  // EVERY hybridSearch call (every kb_search/brain_search/kb_search_privileged/incident_match/
  // deep-retrieval query) eligible for shadow sampling -- unlike this fleet's other advisory
  // kill-switches, this one defaults OFF rather than on, because the "on" state has a real,
  // non-zero cost per sampled call (a second embed + a second Azure AI Search query), so it is an
  // explicit operator opt-in, not an ambient default.
  //   SHADOW_EVAL_SAMPLE_RATE   a float in [0, 1], default 0.05 (5%)
  // The fraction of hybridSearch calls (once SHADOW_EVAL_MODE=on) that ALSO run a candidate
  // variant. Unparseable/unset falls back to the 5% default rather than sampling 0% or 100% by
  // accident. Bounds the extra cost: at 5%, shadow eval roughly doubles the retrieval cost of one
  // call in twenty, not every call.
  //   SHADOW_EVAL_STRATEGY      baseline (default) | demote-off | demote-on | rerank-off | rerank-on
  // Names which candidate ranking/demotion variant the sampled shadow run applies (see
  // shadow-eval.ts's SHADOW_STRATEGIES registry to add a new one). An unknown/unset name falls back
  // to 'baseline' (a genuine no-op re-run, useful as a sanity check on the eval pipeline itself)
  // rather than throwing or disabling shadow mode outright.
  // The shadow run's result is NEVER returned to the caller -- only the live path's result is, byte-
  // identical to before this feature existed. The shadow run's result is captured (fire-and-forget,
  // reusing safety/journal.ts's exact writeMemory + indexMemoryNow pattern, as a kind:'episode'
  // memory tagged 'shadow-eval' so it is deprioritized by room-hygiene like any other operational
  // exhaust) for a nightly comparison job to read later -- that job is not part of this change, this
  // only makes the comparison DATA available. Fail-open end to end: an unconfigured Cosmos, a
  // Search/Foundry outage, or the candidate re-run itself throwing all degrade to "no comparison
  // written" rather than ever affecting the live call's latency, result, or failure rate.

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
