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
// web_research / web_extract (Task G-3, 2026-09-03): web_search's own deeper-research and
// fetch-a-known-URL siblings, seeded into the SAME open-RAG group so every internal lane's
// allowlist gains them the moment web_search is present -- consistent with how this group already
// treats every other member as "the same exposure, one decision".
const RAG_OPEN = ['brain_search', 'web_search', 'web_research', 'web_extract', 'kb_search', 'search', 'fetch', 'incident_match'] as const;
const RAG_PRIVILEGED = ['kb_search_privileged', 'kb_get_document'] as const;
const LLM = ['llm_azure'] as const;
const SAFETY_CHECKS = ['shield_check', 'groundedness_check', 'claims_check'] as const;
// HeyGen visibility for the six approved internal lanes. Execution remains independently constrained:
// data/semantic handlers re-check the exact six lanes; pairing and prompt creation are CTO-only in-handler + governance.
const HEYGEN = ['heygen_*'] as const;
// The CTO's full infra/build/observability surface, reused verbatim by 'exec' (the unified chief
// wears the CTO hat too, per the "solo operator" note in kb/search-privileged.ts).
// 'azure_*' was dropped from this list 2026-08-28: the 13 azure_* tools were deleted outright (not
// merely darkened) -- the Azure subscription behind them (55c84f6b) is permanently deleted, so
// unlike every other prefix here there is no future state in which they answer again. Leaving a
// dead wildcard in a seed allowlist is harmless (it simply matches nothing), but a live one that
// used to advertise real tools reads as a stale claim about this lane's actual capability.
const CTO_INFRA = [
  'github_*', 'depot_*', 'build_*', 'release_*', 'cloudflare_*', 'netlify_*', 'n8n_*',
  'posthog_*', 'sentry_*', 'gumroad_*', 'docintel_*', 'graph_*', 'cio_*', 'stripe_*', 'twilio_*',
  'elevenlabs_*', 'xero_*', 'legal_blob_*', 'shopify_*', 'intercom_*', 'revenuecat_*',
  ...HEYGEN,
] as const;
// The customer-service-engine Graph mail tools (2026-07-25, CRO handoff): send/list/get/mark-read,
// all mailbox-allowlisted server-side (see graph/api-client.ts's allowedMailboxes()). Named
// explicitly rather than 'graph_*' for the non-CTO/exec lanes below, since those lanes should NOT
// also see graph_drive_* (OneDrive) or any future graph_* addition without an explicit decision.
const GRAPH_MAIL = ['graph_send_email', 'graph_list_messages', 'graph_message_get', 'graph_mark_read'] as const;

/**
 * M365-SPECIFIC CURATION FIX (2026-08-02, "curate-m365-only doesn't actually curate the two
 * broadest lanes" root cause, part 1 of 2 -- see registry.ts's primaryHandlesByServer comment for
 * part 2, the alias-doubling fix). CTO_INFRA's broad service-prefix wildcards (azure_*, github_*,
 * xero_*, stripe_*, posthog_*, ...) were each individually reasonable, but several of the services
 * behind them have a LARGE tool surface (stripe_* alone is 92 tools; the full azure/github/depot/
 * cloudflare/xero/posthog/graph family covers the vast majority of the ~914-tool catalog end to
 * end) -- so 'cto' admitted 905 of 914 canonical tools (99%) and 'cro' admitted 485 (53%),
 * live-measured against production 2026-08-02, making TOOL_CATALOG_CURATION_MODE=curate-m365-only
 * nearly a no-op for exactly the two lanes it most needed to shrink.
 *
 * These two explicit, name-level allowlists are a snapshot of the SAME hand-curated per-role tool
 * sets already built and reviewed for the M365 declarative-agent manifests
 * (otchealth-cto/copilot-agents/curated-mcp-tools-{cto,cro}.json, otchealth-cto repo, generated by
 * build-agents.mjs) -- reusing that existing, deliberately-curated work as this gateway's dynamic
 * M365 seed instead of inventing a second, divergent heuristic. Every name below was verified
 * (2026-08-02) to be a real, currently-registered canonical tool name in this repo.
 *
 * MODE-SCOPE CAVEAT (2026-08-02 Copilot review on PR #185, correcting this comment's earlier
 * overstatement): this table is a `LANE_TOOLSETS` entry, the SAME table `evaluateCatalogCuration()`
 * consults for EVERY mode that curates at all. Under the currently-armed, currently-deployed
 * `curate-m365-only` mode, these two lists really do ONLY narrow M365 static-token requests -- a
 * Claude Code / Hyperagent client_credentials session on cto/cro is left fully uncurated, exactly as
 * this comment used to (correctly, for that one mode) claim. But under plain `curate` mode
 * (tool-catalog-curation.ts's other non-default opt-in), `evaluateCatalogCuration()` applies this
 * SAME table to EVERY caller on the lane, M365 or not -- so a live Claude Code/Hyperagent cto or cro
 * session WOULD be narrowed to this list too if an operator ever flips the mode from
 * `curate-m365-only` to plain `curate`. Do not infer from this comment that `curate` is safe for
 * those sessions; re-read tool-catalog-curation.ts's own mode-by-mode header before flipping modes.
 * 'exec' keeps the full CTO_INFRA wildcard breadth regardless (it has no M365 static token, so it is
 * never curated under the live mode -- but it WOULD be narrowed too under plain `curate`, same
 * caveat). To refresh: rerun build-agents.mjs, extract each file's `.map(t => t.name)`, and replace
 * the array body below.
 */
// The 13 azure_* names below this list once carried were removed 2026-08-28 (tools deleted outright,
// see CTO_INFRA's comment above for why); this snapshot is otherwise unchanged from the 2026-08-02
// build-agents.mjs export, so it is no longer byte-identical to that generated file until the next
// refresh removes the same names there too.
const CTO_M365_CURATED = [
  'agent_dispatch',
  'brain_search', 'catalog_audit_unused', 'catalog_list_tools', 'catalog_master', 'catalog_probe',
  'cio_admin_read_*', 'cio_admin_write_*',
  'catalog_service_capabilities', 'catalog_skill', 'checkpoint', 'cloudflare_add_email_destination',
  'cloudflare_cache_purge_all', 'cloudflare_cache_purge_by_tag', 'cloudflare_cache_purge_by_url',
  'cloudflare_create_dns_record', 'cloudflare_create_email_rule', 'cloudflare_delete_dns_record',
  'cloudflare_delete_email_rule', 'cloudflare_dns_export', 'cloudflare_dns_import', 'cloudflare_dns_record_get',
  'cloudflare_dnssec_get', 'cloudflare_dnssec_update', 'cloudflare_email_routing_disable', 'cloudflare_email_routing_dns_records',
  'cloudflare_email_routing_enable', 'cloudflare_email_routing_get_catch_all', 'cloudflare_email_routing_get_settings',
  'cloudflare_email_routing_update_catch_all', 'cloudflare_filter_create', 'cloudflare_filter_delete',
  'cloudflare_filter_get', 'cloudflare_filter_list', 'cloudflare_filter_update', 'cloudflare_firewall_rule_create',
  'cloudflare_firewall_rule_delete', 'cloudflare_firewall_rule_get', 'cloudflare_firewall_rule_list',
  'cloudflare_firewall_rule_update', 'cloudflare_list_dns_records', 'cloudflare_list_email_destinations',
  'cloudflare_list_email_rules', 'cloudflare_page_rule_create', 'cloudflare_page_rule_delete', 'cloudflare_page_rule_get',
  'cloudflare_page_rule_list', 'cloudflare_page_rule_update', 'cloudflare_rate_limit_rule_create',
  'cloudflare_rate_limit_rule_delete', 'cloudflare_rate_limit_rule_list', 'cloudflare_redirect_list_add_items',
  'cloudflare_redirect_list_delete_items', 'cloudflare_redirect_list_get_items', 'cloudflare_redirect_list_list',
  'cloudflare_update_dns_record', 'cloudflare_update_email_rule', 'cloudflare_workers_route_get',
  'cloudflare_workers_route_list', 'cloudflare_zone_get', 'cloudflare_zone_get_settings', 'cloudflare_zone_list',
  'cloudflare_zone_update_setting', 'depot_artifact_url_get', 'depot_artifacts_list', 'depot_attempt_get',
  'depot_attempt_metrics_get', 'depot_build_step_logs_get', 'depot_build_steps_get', 'depot_failure_diagnosis_get',
  'depot_job_cancel', 'depot_job_get', 'depot_job_metrics_get', 'depot_job_retry', 'depot_job_retry_failed',
  'depot_job_summary_get', 'depot_list_projects', 'depot_logs_get', 'depot_project_create', 'depot_project_delete',
  'depot_project_get', 'depot_project_reset', 'depot_project_trust_add', 'depot_project_trust_list',
  'depot_project_trust_remove', 'depot_project_update', 'depot_registry_images_delete', 'depot_registry_images_list',
  'depot_run_cancel', 'depot_run_get', 'depot_run_list', 'depot_run_metrics_get', 'depot_run_status_get',
  'depot_token_create', 'depot_token_delete', 'depot_token_list', 'depot_token_update', 'depot_trigger_build',
  'depot_usage_get', 'depot_usage_list', 'depot_usage_org_get', 'depot_workflow_cancel', 'depot_workflow_get',
  'depot_workflow_list', 'depot_workflow_rerun', 'fetch', 'gateway_fetch_result', 'github_add_labels',
  'github_branch_get',
] as const;
const CRO_M365_CURATED = [
  'brain_search', 'catalog_list_tools', 'checkpoint', 'cio_admin_read_*', 'cio_admin_write_*',
  'cio_broadcast_get', 'cio_broadcast_get_metrics',
  'cio_broadcast_list', 'cio_campaign_get', 'cio_campaign_get_actions', 'cio_campaign_get_metrics',
  'cio_campaign_list', 'cio_create_or_update_customer', 'cio_customer_get_activities', 'cio_customer_get_attributes',
  'cio_customer_get_messages', 'cio_customer_get_segments', 'cio_customer_merge', 'cio_customer_search',
  'cio_delete_customer', 'cio_get_customer', 'cio_get_newsletter', 'cio_get_newsletter_metrics', 'cio_get_segment',
  'cio_list_newsletters', 'cio_list_segment_people', 'cio_message_get', 'cio_message_list', 'cio_segment_add_customers',
  'cio_segment_create', 'cio_segment_get_membership_count', 'cio_segment_list', 'cio_segment_remove_customers',
  'cio_send_transactional', 'cio_suppress_customer', 'cio_track_event', 'cio_transactional_get', 'cio_transactional_list',
  'cio_trigger_broadcast', 'cio_unsuppress_customer', 'cio_update_customer_attributes', 'fetch', 'gumroad_disable_product',
  'gumroad_enable_product', 'gumroad_list_products', 'gumroad_list_sales', 'gumroad_offer_code_create',
  'gumroad_offer_code_get', 'gumroad_offer_code_list', 'gumroad_offer_code_update', 'gumroad_product_get',
  'gumroad_sale_get', 'gumroad_sale_mark_shipped', 'gumroad_sale_refund', 'gumroad_sale_resend_receipt',
  'gumroad_subscriber_get', 'gumroad_subscriber_list', 'gumroad_update_product', 'incident_match',
  'intercom_add_note', 'intercom_company_create', 'intercom_company_get', 'intercom_company_list',
  'intercom_company_list_contacts', 'intercom_company_update', 'intercom_contact_get', 'intercom_contact_list',
  'intercom_contact_list_companies', 'intercom_contact_list_tags', 'intercom_contact_search', 'intercom_contact_update',
  'intercom_conversation_close', 'intercom_conversation_get', 'intercom_conversation_list', 'intercom_conversation_open',
  'intercom_conversation_search', 'intercom_create_contact', 'intercom_create_conversation', 'intercom_reply_conversation',
  'intercom_segment_get', 'intercom_segment_list', 'intercom_tag_company', 'intercom_tag_contact',
  'intercom_tag_list', 'intercom_ticket_create', 'intercom_ticket_get', 'intercom_ticket_search',
  'intercom_ticket_update', 'kb_get_document', 'kb_search', 'memory_recall', 'memory_remember', 'memory_search',
  'memory_team', 'memory_write', 'posthog_cohort_get', 'posthog_cohort_list', 'posthog_dashboard_get',
  'posthog_dashboard_list', 'posthog_event_definition_list', 'posthog_experiment_get', 'posthog_experiment_list',
  'posthog_insight_get', 'posthog_insight_list', 'posthog_list_projects', 'posthog_project_get', 'posthog_property_definition_list',
  'posthog_query_hogql', 'posthog_survey_list', 'revenuecat_app_get', 'revenuecat_app_list', 'revenuecat_customer_create',
  'revenuecat_customer_delete', 'revenuecat_customer_get', 'revenuecat_customer_get_active_entitlements',
  'revenuecat_customer_get_attributes', 'revenuecat_customer_get_purchases', 'revenuecat_customer_get_subscriptions',
  'revenuecat_customer_list', 'revenuecat_customer_list_invoices', 'revenuecat_entitlement_create',
  'revenuecat_entitlement_delete',
] as const;

export const LANE_TOOLSETS: Record<KnownInternalLane, readonly string[]> = {
  // The mastermind seat: infra, builds, releases, the full ship cycle, and every read surface it uses
  // to decide whether landing something is safe. NOT an EXEC_RING member (search-privileged.ts), so
  // kb_search_privileged / legal_blob_* / xero_* still ring-gate in-handler even though they are
  // seeded here for parity with the CTO_SHIP_LANE_TOOLSET connector surface (registry.ts).
  // NOTE (2026-08-02): uses CTO_M365_CURATED (an explicit, deliberately-curated ~120-tool name list)
  // instead of the broad CTO_INFRA wildcards -- see CTO_M365_CURATED's doc comment above for why
  // (CTO_INFRA's wildcards admitted 99% of the whole catalog, live-measured, defeating
  // curate-m365-only). Only matters under the currently-armed curate-m365-only mode (an M365 static-
  // auth caller); a Claude Code/Hyperagent cto session is unaffected either way today. If universal
  // 'curate' mode is ever armed for the cto lane specifically, this same narrower list would then also
  // apply there -- a deliberate call to make at that time, not implied by this change.
  cto: [...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM, ...SAFETY_CHECKS, ...CTO_M365_CURATED, ...HEYGEN, 'agent_persona'],
  // Engineering IC: its OWN app-repo ship cycle (branch/commit/PR/CI/dispatch) plus the shared
  // read/memory/task surface. No Azure control plane, no finance, no legal -- infra and the two
  // genuinely sensitive corpora (MNPI finance, privileged legal) are CTO/EXEC_RING-owned, not
  // developer's (see kb/search-privileged.ts's ring model).
  developer: [
    ...RAG_OPEN, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'github_*', 'depot_*', 'posthog_query_hogql', 'posthog_insight_list', 'sentry_list_issues',
    ...HEYGEN,
    // 2026-08-02: developer_wake_lite (diagnostics/developer-wake-lite.ts) was never covered by
    // any pattern above -- not catalog_* (CATALOG's wildcard), not github_*/depot_*, no exact
    // match -- so under curate-m365-only it was silently excluded from what's actually registered
    // for an M365 developer session, even though catalog_probe's known_tools_present check
    // (which reads the full unscoped catalog, not this lane's curated view) reported it "true"
    // and masked the gap. Ironic: this tool exists specifically to diagnose M365 tool-visibility
    // issues and was itself invisible to the exact lane it was built to diagnose. Confirmed live
    // 2026-08-02: Copilot calling the M365-truncated form "wake_lite" got "Tool wake_lite not
    // found" because the primary was never registered for this caller, so no alias was ever
    // collected either.
    'developer_wake_lite',
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
    ...GRAPH_MAIL, 'cio_*', ...HEYGEN,
  ],
  // Revenue / commerce: storefront, lifecycle CRM, help center, digital-products cash lane, revenue
  // analytics. Also removed from EXEC_RING 2026-07-21 (securities firewall: revenue never touches
  // finance MNPI or company-legal). GRAPH_MAIL added 2026-07-25 (CRO customer-service-engine
  // handoff): the CS engine sends/reads as care@/sarah@/helen@/ray@ via this lane.
  // NOTE (2026-08-02): uses CRO_M365_CURATED instead of the broad shopify_*/stripe_*/cio_*/
  // intercom_*/gumroad_*/revenuecat_*/posthog_* wildcards -- those wildcards admitted 485 of 914
  // canonical tools (53%, live-measured), the second-worst offender after cto. Same scope caveat as
  // cto's CTO_M365_CURATED note above: only matters under curate-m365-only today.
  cro: [
    ...RAG_OPEN, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    ...CRO_M365_CURATED, ...GRAPH_MAIL, ...HEYGEN,
  ],
  // Product: app analytics, crash/error tracking, subscription entitlements, the privileged RAG rooms
  // (a dormant EXEC_RING member per search-privileged.ts -- no live client yet, seeded here for
  // parity, not because usage has proven it).
  cpo: [
    ...RAG_OPEN, ...RAG_PRIVILEGED, ...MEMORY, ...WORK_LEDGER, ...CATALOG, ...LLM,
    'posthog_*', 'sentry_*', 'revenuecat_*', ...HEYGEN,
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
