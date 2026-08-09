/**
 * Capability Catalog — the gateway's self-describing index.
 *
 * Tools auto-register here via recordTool() (called from tools/registry.ts at
 * registration time), so catalog_list_tools is ALWAYS truthful about what is wired.
 * SERVICE_CATALOG declares each service's purpose, ring, auth, and the broader API
 * surface that is available-but-not-yet-wired, so catalog_audit_unused can surface
 * "capabilities left on the table" (whole-service backlog + per-service partial coverage).
 */

export type ToolCategoryName = 'read' | 'write_simple' | 'write_orchestrated';

export interface CatalogEntry {
  name: string;
  service: string;
  category: ToolCategoryName;
  title: string;
  description: string;
  readOnly: boolean;
}

const registeredTools: CatalogEntry[] = [];

/** Record a registered tool. Idempotent by tool name (safe across reloads/tests). */
export function recordTool(entry: CatalogEntry): void {
  const i = registeredTools.findIndex((t) => t.name === entry.name);
  if (i >= 0) registeredTools[i] = entry;
  else registeredTools.push(entry);
}

/** Service key = the tool name prefix before the first underscore (e.g. stripe_get_balance -> stripe). */
export function deriveService(toolName: string): string {
  const idx = toolName.indexOf('_');
  return idx === -1 ? toolName : toolName.slice(0, idx);
}

export function allTools(): CatalogEntry[] {
  return [...registeredTools];
}

/** Count of registered tools. Surfaced in /health so a deploy that regresses the catalog fails the gate. */
export function toolCount(): number {
  return registeredTools.length;
}

/**
 * A short, deterministic fingerprint of the CURRENT tool catalog (name+category, sorted). Changes
 * whenever a tool is added, removed, or recategorized. Exists so a client can detect a STALE cached
 * tools/list without a human first having to notice a "missing" tool is actually just an unrefreshed
 * cache (CFO P1-A / P0-1 post-mortem, 2026-07-30: a full connector reconnect did NOT clear a client's
 * cached MCP tool list, and the resulting "xero_attachment_upload is absent" symptom cost two full
 * review rounds before the real cause -- a stale cache, not a missing/allowlist bug -- was found by
 * asking the gateway's own catalog directly). Cheap FNV-1a hash (no crypto import needed for a
 * non-security fingerprint); collisions are not a security concern here, only a staleness signal.
 * Pure/testable.
 */
export function catalogVersion(): string {
  const key = allTools()
    .map((t) => `${t.name}:${t.category}`)
    .sort()
    .join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface ServiceInfo {
  description: string;
  ring: 'non-phi' | 'phi-carved-out';
  auth: string;
  status: 'wired' | 'planned';
  /** Capabilities the service offers that are NOT yet wired as gateway tools. */
  available: string[];
  /** Governance rule for this service's actions (who may EXECUTE), surfaced in the master catalog. */
  rule?: string;
}

/**
 * Hand-maintained service declarations. "wired" services have tools registered;
 * "planned" services are the backlog (no tools yet). `available` lists known API
 * surface not yet exposed. Keep in sync with docs/UNIFIED-FLEET-GATEWAY.md.
 */
export const SERVICE_CATALOG: Record<string, ServiceInfo> = {
  cio: {
    description: 'Customer.io lifecycle CRM: newsletters, segments, customers, events.',
    ring: 'non-phi', auth: 'CIO_SITE_ID / CIO_TRACK_KEY / CIO_APP_API_BEARER', status: 'wired',
    available: [],
  },
  cloudflare: {
    description: 'Cloudflare fleet email routing + DNS.',
    ring: 'non-phi', auth: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID', status: 'wired',
    available: [],
  },
  graph: {
    description: 'Microsoft Graph: COO send-as email + inbox + calendar/contacts, and OneDrive/Graph Drive role three-folder exchange (Outgoing/Incoming/Processed).',
    ring: 'non-phi', auth: 'GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_DRIVE_USER', status: 'wired',
    available: [],
    rule: 'graph_drive_* are gated by folder-name role prefix: a caller may only touch its OWN role folders. Uploads are fail-closed against silent overwrite.',
  },
  legal: {
    description: 'Legal document store on Azure Blob (account otchealthlegalstore): containers company + personal. RING-GATED — personal = attorney-privileged CA divorce/civil matters, the most sensitive corpus in the fleet.',
    ring: 'non-phi', auth: 'AZURE_LEGAL_STORAGE_ACCOUNT / AZURE_LEGAL_STORAGE_KEY (SharedKey)', status: 'wired',
    available: [],
    rule: 'container=personal requires the legal-personal executive ring; container=company requires the legal-company ring (derived from kb/search-privileged INDEX_LANES). The cto/default/external identity is refused. legal_blob_put is fail-closed against silent overwrite.',
  },
  stripe: {
    description: 'Stripe read-only scoreboard (CFO/CRO visibility).',
    ring: 'non-phi', auth: 'STRIPE_SECRET_KEY', status: 'wired',
    available: [],
  },
  shopify: {
    description: 'Shopify storefront (otchealthmart.com): products, orders, abandoned checkouts.',
    ring: 'non-phi', auth: 'SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN', status: 'wired',
    available: [],
  },
  intercom: {
    description: 'Intercom help-center articles.',
    ring: 'non-phi', auth: 'INTERCOM_ACCESS_TOKEN', status: 'wired',
    available: [],
  },
  n8n: {
    description: 'n8n self-host meta-tools (workflows, executions).',
    ring: 'non-phi', auth: 'N8N_BASE_URL / N8N_API_KEY / N8N_WEBHOOK_SECRET', status: 'wired',
    available: [],
  },
  netlify: {
    description: 'Netlify deploy visibility (INND site + portfolio).',
    ring: 'non-phi', auth: 'NETLIFY_AUTH_TOKEN', status: 'wired',
    available: [],
  },
  gumroad: {
    description: 'Gumroad digital-products cash scoreboard.',
    ring: 'non-phi', auth: 'GUMROAD_ACCESS_TOKEN', status: 'wired',
    available: [],
  },
  catalog: {
    description: 'Capability Catalog: the gateway self-describing its own toolset.',
    ring: 'non-phi', auth: 'none (internal introspection)', status: 'wired',
    available: [],
  },
  sentry: {
    description: 'Sentry crash/error monitoring + releases (MedReview PHI projects carved out).',
    ring: 'phi-carved-out', auth: 'SENTRY_AUTH_TOKEN / SENTRY_ORG', status: 'wired',
    available: [], rule: 'medreview* projects are PHI — refused on read and write.',
  },
  memory: {
    description: 'Cross-agent shared brain (kb-memory commons): recall, team view, pack, remember.',
    ring: 'non-phi', auth: 'AZURE_COMMONS_STORAGE_* / AZURE_SEARCH_*', status: 'wired',
    available: [],
  },
  agent: {
    description: 'Agent persona bootstrap (public dream-team personas for cross-platform identity).',
    ring: 'non-phi', auth: 'none (public personas only)', status: 'wired',
    available: [], rule: 'Only PUBLIC personas served; exec personas (cto/cfo) withheld.',
  },
  docintel: {
    description: 'Azure Document Intelligence: invoice (CFO) + contract (CLO) analysis. Non-BAA — never PHI.',
    ring: 'non-phi', auth: 'DOCINTEL_ENDPOINT / DOCINTEL_KEY', status: 'wired',
    available: [], rule: 'Never send PHI/MedReview documents through this gateway.',
  },
  kb: {
    description: 'Fleet knowledge RAG over Azure AI Search (commons open; finance/legal ring-gated).',
    ring: 'non-phi', auth: 'AZURE_SEARCH_*', status: 'wired',
    available: [], rule: 'Privileged (finance/legal) index access is ring-gated.',
  },
  llm: {
    description: 'Credit-funded Azure OpenAI commodity path (gpt-4.1/5.x) — the cost-protocol escape hatch.',
    ring: 'non-phi', auth: 'FOUNDRY_OPENAI_ENDPOINT / FOUNDRY_KEY', status: 'wired',
    available: [],
  },
  shield: {
    description: 'Azure AI Content Safety Prompt Shields (jailbreak / indirect-injection defense).',
    ring: 'non-phi', auth: 'CONTENT_SAFETY_ENDPOINT / CONTENT_SAFETY_KEY', status: 'wired',
    available: [],
  },
  groundedness: {
    description: 'Azure AI Content Safety groundedness detection (anti-hallucination check).',
    ring: 'non-phi', auth: 'CONTENT_SAFETY_ENDPOINT / CONTENT_SAFETY_KEY', status: 'wired',
    available: [],
  },
  elevenlabs: {
    description: 'ElevenLabs voice (voices list, TTS) via the Twilio voice-fleet lane.',
    ring: 'non-phi', auth: 'ELEVENLABS_API_KEY', status: 'wired',
    available: [], rule: 'Outbound voice is TCPA-adjacent; generation only, no autonomous dial-out.',
  },
  // ---- BACKLOG (planned; no tools wired yet) ----
  depot: {
    description: 'Depot build/CI: builds, cache, grant-burn usage (macOS ~10x cost).',
    ring: 'non-phi', auth: 'DEPOT_TOKEN / DEPOT_PROJECT_ID', status: 'wired',
    available: [],
  },
  posthog: {
    description: 'PostHog management (flags, insights, projects). MedReview PHI project 468398 carved OUT.',
    ring: 'phi-carved-out', auth: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_HOST', status: 'wired',
    available: [],
  },
  revenuecat: {
    description: 'RevenueCat subscriber + entitlement reads (v2).',
    ring: 'non-phi', auth: 'REVENUECAT_V2_API_KEY', status: 'wired',
    available: [],
  },
  twilio: {
    description: 'Twilio + ElevenLabs voice fleet (Helen/Sarah/Roger/Fin).',
    ring: 'non-phi', auth: 'TWILIO_* / ELEVENLABS_API_KEY', status: 'wired',
    available: [],
  },
  github: {
    description: 'GitHub passthrough (the gateway "everything via one connector" story).',
    ring: 'non-phi', auth: 'GITHUB_TOKEN', status: 'wired',
    available: [],
  },
  // Phase 6: the OpenAI ChatGPT / Deep Research connector contract. The tool names `search`/`fetch`
  // carry no prefix (a fixed third-party naming requirement), so deriveService() buckets each as
  // its own singleton service rather than a shared "openai" prefix group.
  search: {
    description: 'OpenAI ChatGPT / Deep Research connector: hybrid search over the non-privileged company brain (memory-exec, commons-company-journal only). See kb/openai-search.ts.',
    ring: 'non-phi', auth: 'AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_QUERY_KEY', status: 'wired',
    available: [],
    rule: 'Room selection is hard-capped to the non-privileged allow-set for every caller, including cto/exec — stricter than brain_search on purpose. OPENAI_SEARCH_MODE=off disables it.',
  },
  fetch: {
    description: 'OpenAI ChatGPT / Deep Research connector: resolve a search() citation id to full text. See kb/openai-fetch.ts.',
    ring: 'non-phi', auth: 'AZURE_SEARCH_ENDPOINT / AZURE_SEARCH_QUERY_KEY', status: 'wired',
    available: [],
    rule: 'Re-derives the room from the id and re-checks it against the non-privileged allow-set on every call; never trusts the id. OPENAI_SEARCH_MODE=off disables it.',
  },
};

export interface ServiceListing {
  service: string;
  tool_count: number;
  tools: { name: string; category: ToolCategoryName; read_only: boolean; title: string }[];
}

export function listTools(serviceFilter?: string): ServiceListing[] {
  const services = [...new Set(registeredTools.map((t) => t.service))].sort();
  return services
    .filter((s) => !serviceFilter || s === serviceFilter)
    .map((s) => {
      const tools = registeredTools
        .filter((t) => t.service === s)
        .map((t) => ({ name: t.name, category: t.category, read_only: t.readOnly, title: t.title }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { service: s, tool_count: tools.length, tools };
    });
}

export function serviceCapabilities(service: string) {
  const info = SERVICE_CATALOG[service] ?? EXTRA_SERVICES[service];
  const wired = registeredTools.filter((t) => t.service === service).map((t) => t.name).sort();
  return {
    service,
    known: Boolean(info),
    description: info?.description ?? null,
    ring: info?.ring ?? 'non-phi',
    auth: info?.auth ?? null,
    status: info?.status ?? (wired.length ? 'wired' : 'unknown'),
    wired_tools: wired,
    available_not_wired: info?.available ?? [],
  };
}

export function auditUnused() {
  // The master catalog is SERVICE_CATALOG + the EXTRA_SERVICES fleet connectors (planned/known).
  const catalog: Record<string, ServiceInfo> = { ...SERVICE_CATALOG, ...EXTRA_SERVICES };
  const wiredServices = new Set(registeredTools.map((t) => t.service));
  const declared = Object.keys(catalog);

  const planned_services = declared
    .filter((s) => catalog[s].status === 'planned' || !wiredServices.has(s))
    .map((s) => ({ service: s, description: catalog[s].description, planned_tools: catalog[s].available }));

  const partial_coverage = declared
    .filter((s) => wiredServices.has(s) && (catalog[s].available?.length ?? 0) > 0)
    .map((s) => ({
      service: s,
      wired_count: registeredTools.filter((t) => t.service === s).length,
      available_not_wired: catalog[s].available,
    }));

  const undocumented_services = [...wiredServices].filter((s) => !catalog[s]).sort();

  return {
    planned_services,
    partial_coverage,
    undocumented_services,
    summary: `${planned_services.length} planned service(s), ${partial_coverage.length} wired service(s) with un-wired capabilities, ${undocumented_services.length} undocumented wired service(s).`,
  };
}


// ---- EXTRA fleet connectors (known to the fleet; surfaced in the master catalog) ----
// Merged with SERVICE_CATALOG by catalog_master. "planned" = not yet wired as gateway tools.
export const EXTRA_SERVICES: Record<string, ServiceInfo> = {
  depot: { description: 'Depot build/CI (iOS macOS + Linux) and grant-burn.', ring: 'non-phi', auth: 'DEPOT_TOKEN', status: 'wired', available: [], rule: 'CTO-ONLY to kick off a build/upload (all agents may SEE/read build status).' },
  posthog: { description: 'PostHog product analytics + flags (MedReview PHI project carved OUT).', ring: 'phi-carved-out', auth: 'POSTHOG_PERSONAL_API_KEY', status: 'wired', available: [], rule: 'Never expose the MedReview PHI project (468398).' },
  revenuecat: { description: 'RevenueCat subscriptions/entitlements (read).', ring: 'non-phi', auth: 'REVENUECAT_V2_API_KEY', status: 'wired', available: [] },
  twilio: { description: 'Twilio SMS/voice + ElevenLabs voice.', ring: 'non-phi', auth: 'TWILIO SID+token / ELEVENLABS xi-api-key', status: 'wired', available: [], rule: 'Outbound SMS/calls are TCPA-gated (CCO approval) - never autonomous.' },
  sentry: { description: 'Sentry crash/error monitoring (read).', ring: 'non-phi', auth: 'SENTRY_AUTH_TOKEN', status: 'wired', available: [], rule: 'MedReview (medreview-*) projects are PHI - excluded.' },
  github: { description: 'GitHub repos/PRs/Actions.', ring: 'non-phi', auth: 'github-app token', status: 'wired', available: [], rule: 'iOS build/release dispatch is CTO-only.' },
  mercury: { description: 'Mercury banking (read).', ring: 'non-phi', auth: 'mercury token', status: 'planned', available: ['balances', 'transactions'], rule: 'Finance data - CFO lane; not for external clients.' },
  xero: { description: 'Xero accounting of record (read-only): reports (trial balance, balance sheet, P&L, aged), chart of accounts, manual journals, bank transactions, invoices across all 4 orgs. QuickBooks is RETIRED (2026-07-16); QBO history lives in the finance data room as static exports.', ring: 'non-phi', auth: 'XERO_CLIENT_ID/SECRET + per-org rotating refresh tokens (Cosmos-managed chain)', status: 'wired', available: [], rule: 'MNPI financial data — executive-ring lanes ONLY (same ring as the finance rooms); never external clients. Read-only by construction: financial writes stay Matt-gated.' },
  plaid: { description: 'Plaid bank aggregation (read).', ring: 'non-phi', auth: 'plaid tokens', status: 'planned', available: ['accounts', 'transactions'], rule: 'Finance data - CFO lane; not for external clients.' },
  heygen: { description: 'HeyGen subscription-credit avatar production, discovery, ingestion, and technical QA.', ring: 'non-phi', auth: 'durable OAuth broker (API keys rejected)', status: 'wired', available: ['avatar and voice discovery', 'direct Avatar Video', 'Video Agent/brand/translation reads', 'artifact ingestion and technical QA'], rule: 'Credit-consuming creates and artifact writes are CTO-only, balance-bound, and idempotent; no API-key billing path.' },
};

// ---- Fleet SKILLS (octools, public repo skills/<name>/SKILL.md) - snapshot; live source is the repo ----
export const SKILLS: string[] = ["agent-evals","amazon-sp-api","analyzing-financial-statements","aso-growth","attack-tree-construction","auth-implementation-patterns","billing-automation","brainstorming","browser-agent","cfo-onedrive","cfo-sharepoint","cfo-store","company-brain","competitive-landscape","content-engine","contract-analyzer","contract-redliner","coo","creating-financial-models","cto-onedrive","daily-briefing","daily-digest","datadog","designer","devkit","digital-products","dispatching-parallel-agents","distributed-tracing","doc-indexer","edgartools","employment-contract-templates","error-handling-patterns","eval-runner","executing-plans","fleet-dispatch","fleet-medic","fleet-telemetry","focus-group-loop","gdpr-data-handling","github-app","gmail","grant-tracker","growth-pr","heygen-video","incident-runbook-templates","innd-stock","ir-support","kb-memory","kpi-dashboard-design","legal","lifecycle-crm","live-walkthrough","m365-mail","market-sizing-analysis","monetization","paid-ads","partnerships","pci-compliance","pdf","plaid-banking","postmortem-writing","quickbooks","raise-ops","receiving-code-review","release-conductor","requesting-code-review","sast-configuration","scaffolder","screen-reader-testing","shark-tank","skills-discovery","slo-implementation","sql-optimization-patterns","startup-financial-modeling","storefront-cro","stripe-integration","subagent-driven-development","sunset-protocol","supply-chain-guard","systematic-debugging","telemetry-wiring","test-author","test-driven-development","threat-mitigation-mapping","vault-sync","verification-before-completion","voice-ops","wcag-audit-patterns","writing-plans","xero"];

export const PLUGINS: string[] = ["sunset-protocol"];

export const SKILLS_REPO = 'https://github.com/InnerScopeHearing/otchealth-claude-tools/tree/main/skills';
