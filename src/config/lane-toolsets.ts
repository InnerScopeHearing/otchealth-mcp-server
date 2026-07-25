/**
 * Per-lane curated tool ALLOWLIST for internal client_credentials lanes (Wave 6 item 6.2, the
 * "token-tax fix"). Every tool advertised in a tools/list response costs prompt tokens for the
 * connected agent to read, so a lane that only ever calls 10 of the ~850 registered tools is still
 * paying the token cost of all ~850 being advertised on every connection.
 *
 * This is the SAME idea as the pre-existing Claude Chat (DCR) connector curation (registry.ts's
 * CONNECTOR_TOOLSET / EXTERNAL_READONLY_TOOLSET), extended to the INTERNAL client_credentials lanes
 * (server/oauth.ts's resolveClient / OAUTH_CLIENTS: cto, cfo, clo, clo-personal, coo, cro, cpo, cco,
 * developer, exec) that today always see the full catalog, because isConnectorSurface() is only ever
 * true for a dcr_/occ_ client id (auth/bearer.ts) -- a client_credentials lane never sets it.
 *
 * DEFAULT BEHAVIOR IS NON-RESTRICTING. This table is consulted for real curation only when
 * TOOL_CATALOG_CURATION_MODE=curate, which is NOT the default (see safety/tool-catalog-curation.ts).
 * In the default 'report' mode this table is used ONLY to annotate real-usage telemetry
 * (gw_lane_tool_used's in_seed_allowlist field), so the seed below can be refined from PROVEN usage
 * before anyone commits to actually narrowing a lane's advertised toolset.
 *
 * SEED METHODOLOGY (first pass, 2026-07-22): each lane's list is a reasonable guess built from that
 * lane's documented job (see otchealth-cto/CLAUDE.md's per-lane descriptions, kb/search-privileged.ts's
 * ring model, and catalog/governance.ts's role-gated actions), NOT a usage-proven set. Entries are
 * either an EXACT tool name or a 'prefix*' pattern -- the identical matching convention used by
 * catalog/governance.ts's GovRule.pattern (this codebase's other "name or prefix*" table), so the two
 * conventions never silently diverge. Getting this perfectly right on day one is NOT the goal (report
 * mode never restricts anything); the goal is a plausible starting point that report-mode data can
 * later prove or correct.
 *
 * HOW TO REFINE FROM REAL DATA: query the gw_lane_tool_used stream (PostHog Gateway Ops project,
 * POSTHOG_GATEWAYOPS_KEY) per lane over a representative window. Add any tool/prefix that shows real,
 * repeated use but is not yet covered (in_seed_allowlist:false on a tool the lane keeps calling).
 * Consider dropping a group that shows zero use before ever flipping that lane to curate -- and even
 * then, treat curate as a findability/cost optimization, not a security control: the actual security
 * boundaries remain ring gating in kb/search-privileged.ts and role gating in catalog/governance.ts,
 * both completely untouched by this feature (a tool curated OUT of a lane's advertised list was never
 * more than invisible to that lane; the in-handler ring/role checks are the real gate either way).
 */

/**
 * Internal client_credentials lanes this feature has an opinion about. Any OTHER caller identity (an
 * app-lead/product agent like 'iheartest', an empty/unknown caller, a Claude Chat connector lane,
 * etc.) is always left UNCURATED and unlogged by this feature -- see the fail-open branch in
 * safety/tool-catalog-curation.ts's evaluateCatalogCuration().
 */
export const KNOWN_INTERNAL_LANES = [
  'cto',
  'cfo',
  'clo',
  'clo-personal',
  'coo',
  'cro',
  'cpo',
  'cco',
  'developer',
  'exec',
] as const;

export type KnownInternalLane = (typeof KNOWN_INTERNAL_LANES)[number];

export function isKnownInternalLane(lane: string): lane is KnownInternalLane {
  return (KNOWN_INTERNAL_LANES as readonly string[]).includes(lane);
}

// Shared groups so the same "shape" of access (e.g. every memory verb, every task-ledger verb) is
// not hand-copied into every lane's array and left to drift apart over time.
const MEMORY = ['wake', 'checkpoint', 'memory_*'] as const;
const WORK_LEDGER = ['task_*', 'inbox_read', 'agent_dispatch'] as const;
const CATALOG = ['catalog_*', 'gateway_fetch_result'] as const;
const RAG_OPEN = ['brain_search', 'web_search', 'kb_search', 'search', 'fetch', 'incident_match'] as const;
const RAG_PRIVILEGED = ['kb_search_privileged', 'kb_get_document'] as const;
const LLM = ['llm_azure'] as const;
const SAFETY_CHECKS = ['shield_check', 'groundedness_check', 'claims_check'] as const;
// The CTO's full infra/build/observability surface, reused verbatim by 'exec' (the unified chief
// wears the CTO hat too, per the "solo operator" note in kb/search-privileged.ts).
const CTO_INFRA = [
  'azure_*', 'github_*', 'depot_*', 'build_*', 'release_*', 'cloudflare_*', 'netlify_*', 'n8n_*',
  'posthog_*', 'sentry_*', 'gumroad_*', 'docintel_*', 'graph_*', 'cio_*', 'stripe_*', 'twilio_*',
  'elevenlabs_*', 'xero_*', 'legal_blob_*', 'shopify_*', 'intercom_*', 'revenuecat_*',
] as const;
// The customer-service-engine Graph mail tools (2026-07-25, CRO handoff): send/list/get/mark-read,
// all mailbox-allowlisted server-side (see graph/api-client.ts's allowedMailboxes()). Named
// explicitly rather than 'graph_*' for the non-CTO/exec lanes below, since those lanes should NOT
// also see graph_drive_* (OneDrive) or any future graph_* addition without an explicit decision.
const GRAPH_MAIL = ['graph_send_email', 'graph_list_messages', 'graph_get_message', 'graph_mark_read'] as const;

export const LANE_TOOLSETS: Record<KnownInternalLane, readonly string[]> = {
  // The mastermind seat: infra, builds, releases, the full ship cycle, and every read surface it uses
  // to decide whether landing something is safe. NOT an EXEC_RING member (search-privileged.ts), so
  // kb_search_privileged / legal_blob_* / xero_* still ring-gate in-handler even though they are
  // seeded here for parity with the CTO_SHIP_LANE_TOOLSET connector surface (registry.ts).
  cto: [...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM, ...SAFETY_CHECKS, ...CTO_INFRA, 'agent_persona'],
  // Engineering IC: its OWN app-repo ship cycle (branch/commit/PR/CI/dispatch) plus the shared
  // read/memory/task surface. No Azure control plane, no finance, no legal -- infra and the two
  // genuinely sensitive corpora (MNPI finance, privileged legal) are CTO/EXEC_RING-owned, not
  // developer's (see kb/search-privileged.ts's ring model).
  developer: [
    ...RAG_OPEN, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'github_*', 'depot_*', 'posthog_query_hogql', 'posthog_insight_list', 'sentry_list_issues',
  ],
  // Finance / MNPI: Xero (accounting of record), the finance kb rooms, invoice document intelligence,
  // the CFO OneDrive/Graph exchange, plus the shared read/memory/task surface.
  cfo: [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'xero_*', 'stripe_*', 'docintel_*', 'graph_drive_*', ...GRAPH_MAIL,
  ],
  // Company legal: legal_blob_* (company ring), contract/document intelligence, comms, plus the
  // shared read/memory/task surface.
  clo: [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM, ...SAFETY_CHECKS,
    'legal_blob_*', 'docintel_*', ...GRAPH_MAIL,
  ],
  // Personal legal (attorney-privileged CA matters, PERSONAL_LEGAL_RING-gated): a strict SUBSET of
  // clo's list -- no graph_send_email/graph_list_messages, personal matters are not routed through
  // fleet comms tooling.
  'clo-personal': [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'legal_blob_*', 'docintel_*',
  ],
  // Operations: dispatch, comms, Notion-facing briefings. Removed from EXEC_RING 2026-07-21
  // (least-privilege) -- no finance/legal privileged rooms; the ring gate already enforces this
  // in-handler, this list keeps the advertised set honest with that reality.
  coo: [
    ...RAG_OPEN, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    ...GRAPH_MAIL, 'cio_*',
  ],
  // Revenue / commerce: storefront, lifecycle CRM, help center, digital-products cash lane, revenue
  // analytics. Also removed from EXEC_RING 2026-07-21 (securities firewall: revenue never touches
  // finance MNPI or company-legal). GRAPH_MAIL added 2026-07-25 (CRO customer-service-engine
  // handoff): the CS engine sends/reads as care@/sarah@/helen@/ray@ via this lane.
  cro: [
    ...RAG_OPEN, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'shopify_*', 'stripe_*', 'cio_*', 'intercom_*', 'gumroad_*', 'revenuecat_*', 'posthog_*', ...GRAPH_MAIL,
  ],
  // Product: app analytics, crash/error tracking, subscription entitlements, the privileged RAG rooms
  // (a dormant EXEC_RING member per search-privileged.ts -- no live client yet, seeded here for
  // parity, not because usage has proven it).
  cpo: [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'posthog_*', 'sentry_*', 'revenuecat_*',
  ],
  // Compliance / controls: the safety-check tools, the privileged RAG rooms (dormant EXEC_RING
  // member, same caveat as cpo above), legal + document-intelligence visibility for review.
  cco: [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM, ...SAFETY_CHECKS,
    'legal_blob_*', 'docintel_*',
  ],
  // The unified One-Brain chief: every hat at once (per search-privileged.ts's "solo operator" note),
  // so this is deliberately the union of the other EXEC_RING lanes' surfaces plus the CTO's
  // infra/build surface -- the solo operator does not context-switch identities to reach a tool exec
  // legitimately needs.
  exec: [...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM, ...SAFETY_CHECKS, ...CTO_INFRA],
};

/**
 * Pure matcher: true if `toolName` is covered by `lane`'s seed allowlist -- an EXACT match, or a
 * 'prefix*' pattern match. Mirrors catalog/governance.ts's requiredRoleFor() matching convention
 * exactly (this codebase's other "name or prefix*" table) so the two never silently diverge in
 * meaning. Fail-open: an unknown lane not in LANE_TOOLSETS always returns true (see
 * isKnownInternalLane() -- callers are expected to gate on that first; this function does it
 * defensively too so it is safe to call standalone, e.g. directly from a test).
 */
export function isToolInLaneAllowlist(lane: string, toolName: string): boolean {
  const patterns = isKnownInternalLane(lane) ? LANE_TOOLSETS[lane] : undefined;
  if (!patterns) return true;
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (toolName.startsWith(p.slice(0, -1))) return true;
    } else if (toolName === p) {
      return true;
    }
  }
  return false;
}
