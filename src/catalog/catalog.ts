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
    available: ['campaign trigger + list', 'broadcast send', 'journeys', 'people CSV exports'],
  },
  cloudflare: {
    description: 'Cloudflare fleet email routing + DNS.',
    ring: 'non-phi', auth: 'CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID', status: 'wired',
    available: ['list zones', 'cache purge', 'page rules', 'multi-zone (current tools are single-zone)'],
  },
  graph: {
    description: 'Microsoft Graph: COO send-as email + inbox.',
    ring: 'non-phi', auth: 'GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET', status: 'wired',
    available: ['calendar read/create', 'drafts', 'attachments', 'message move/categorize'],
  },
  stripe: {
    description: 'Stripe read-only scoreboard (CFO/CRO visibility).',
    ring: 'non-phi', auth: 'STRIPE_SECRET_KEY', status: 'wired',
    available: ['list subscriptions (api-client.listSubscriptions exists, NO tool yet)', 'invoices', 'payouts', 'refunds (write)'],
  },
  shopify: {
    description: 'Shopify storefront (otchealthmart.com): products, orders, abandoned checkouts.',
    ring: 'non-phi', auth: 'SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN', status: 'wired',
    available: ['list orders', 'customers', 'inventory levels', 'discounts', 'draft orders'],
  },
  intercom: {
    description: 'Intercom help-center articles.',
    ring: 'non-phi', auth: 'INTERCOM_ACCESS_TOKEN', status: 'wired',
    available: ['conversations', 'contacts', 'companies', 'create/update article (write)'],
  },
  n8n: {
    description: 'n8n self-host meta-tools (workflows, executions).',
    ring: 'non-phi', auth: 'N8N_BASE_URL / N8N_API_KEY / N8N_WEBHOOK_SECRET', status: 'wired',
    available: ['execute workflow', 'activate/deactivate', 'list credentials (names only)'],
  },
  netlify: {
    description: 'Netlify deploy visibility (INND site + portfolio).',
    ring: 'non-phi', auth: 'NETLIFY_AUTH_TOKEN', status: 'wired',
    available: ['trigger deploy (write)', 'env vars', 'site DNS', 'build hooks'],
  },
  gumroad: {
    description: 'Gumroad digital-products cash scoreboard.',
    ring: 'non-phi', auth: 'GUMROAD_ACCESS_TOKEN', status: 'wired',
    available: ['subscribers', 'refund (write)', 'per-product sales filters'],
  },
  catalog: {
    description: 'Capability Catalog: the gateway self-describing its own toolset.',
    ring: 'non-phi', auth: 'none (internal introspection)', status: 'wired',
    available: [],
  },
  // ---- BACKLOG (planned; no tools wired yet) ----
  depot: {
    description: 'Depot build/CI: builds, cache, grant-burn usage (macOS ~10x cost).',
    ring: 'non-phi', auth: 'DEPOT_TOKEN / DEPOT_PROJECT_ID', status: 'planned',
    available: ['list projects', 'list builds', 'get build', 'usage / grant-burn monitor'],
  },
  posthog: {
    description: 'PostHog management (flags, insights, projects). MedReview PHI project 468398 carved OUT.',
    ring: 'phi-carved-out', auth: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_HOST', status: 'planned',
    available: ['list/get insights', 'feature flags', 'annotations', 'NEVER expose PHI-project data (build-failing test)'],
  },
  revenuecat: {
    description: 'RevenueCat subscriber + entitlement reads (v2).',
    ring: 'non-phi', auth: 'REVENUECAT_V2_API_KEY', status: 'planned',
    available: ['get subscriber', 'list entitlements', 'list products/offerings'],
  },
  twilio: {
    description: 'Twilio + ElevenLabs voice fleet (Helen/Sarah/Roger/Fin).',
    ring: 'non-phi', auth: 'TWILIO_* / ELEVENLABS_API_KEY', status: 'planned',
    available: ['list calls/messages', 'send SMS (TCPA-gated, write)', 'list ElevenLabs voices'],
  },
  github: {
    description: 'GitHub passthrough (the gateway "everything via one connector" story).',
    ring: 'non-phi', auth: 'GITHUB_TOKEN', status: 'planned',
    available: ['list PRs', 'get file', 'list workflow runs (read passthrough)'],
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
  const info = SERVICE_CATALOG[service];
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
  const wiredServices = new Set(registeredTools.map((t) => t.service));
  const declared = Object.keys(SERVICE_CATALOG);

  const planned_services = declared
    .filter((s) => SERVICE_CATALOG[s].status === 'planned' || !wiredServices.has(s))
    .map((s) => ({ service: s, description: SERVICE_CATALOG[s].description, planned_tools: SERVICE_CATALOG[s].available }));

  const partial_coverage = declared
    .filter((s) => wiredServices.has(s) && (SERVICE_CATALOG[s].available?.length ?? 0) > 0)
    .map((s) => ({
      service: s,
      wired_count: registeredTools.filter((t) => t.service === s).length,
      available_not_wired: SERVICE_CATALOG[s].available,
    }));

  const undocumented_services = [...wiredServices].filter((s) => !SERVICE_CATALOG[s]).sort();

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
  depot: { description: 'Depot build/CI (iOS macOS + Linux) and grant-burn.', ring: 'non-phi', auth: 'DEPOT_TOKEN', status: 'wired', available: ['list projects/builds', 'trigger build', 'usage'], rule: 'CTO-ONLY to kick off a build/upload (all agents may SEE/read build status).' },
  posthog: { description: 'PostHog product analytics + flags (MedReview PHI project carved OUT).', ring: 'phi-carved-out', auth: 'POSTHOG_PERSONAL_API_KEY', status: 'wired', available: ['insights', 'feature flags', 'error tracking'], rule: 'Never expose the MedReview PHI project (468398).' },
  revenuecat: { description: 'RevenueCat subscriptions/entitlements (read).', ring: 'non-phi', auth: 'REVENUECAT_V2_API_KEY', status: 'wired', available: ['subscriber', 'entitlements', 'offerings'] },
  twilio: { description: 'Twilio SMS/voice + ElevenLabs voice.', ring: 'non-phi', auth: 'TWILIO SID+token / ELEVENLABS xi-api-key', status: 'planned', available: ['send SMS', 'calls', 'TTS'], rule: 'Outbound SMS/calls are TCPA-gated (CCO approval) - never autonomous.' },
  sentry: { description: 'Sentry crash/error monitoring (read).', ring: 'non-phi', auth: 'SENTRY_AUTH_TOKEN', status: 'wired', available: ['issues', 'release health'], rule: 'MedReview (medreview-*) projects are PHI - excluded.' },
  github: { description: 'GitHub repos/PRs/Actions.', ring: 'non-phi', auth: 'github-app token', status: 'planned', available: ['repo read', 'PRs', 'Actions'], rule: 'iOS build/release dispatch is CTO-only.' },
  mercury: { description: 'Mercury banking (read).', ring: 'non-phi', auth: 'mercury token', status: 'planned', available: ['balances', 'transactions'], rule: 'Finance data - CFO lane; not for external clients.' },
  quickbooks: { description: 'QuickBooks / Xero accounting (read).', ring: 'non-phi', auth: 'OAuth refresh tokens', status: 'planned', available: ['P&L', 'balance sheet'], rule: 'Finance data - CFO lane; not for external clients.' },
  plaid: { description: 'Plaid bank aggregation (read).', ring: 'non-phi', auth: 'plaid tokens', status: 'planned', available: ['accounts', 'transactions'], rule: 'Finance data - CFO lane; not for external clients.' },
  heygen: { description: 'HeyGen avatar video generation.', ring: 'non-phi', auth: 'heygen key', status: 'planned', available: ['avatar video'] },
};

// ---- Fleet SKILLS (octools, public repo skills/<name>/SKILL.md) - snapshot; live source is the repo ----
export const SKILLS: string[] = ["agent-evals","amazon-sp-api","analyzing-financial-statements","aso-growth","attack-tree-construction","auth-implementation-patterns","billing-automation","brainstorming","browser-agent","cfo-onedrive","cfo-sharepoint","cfo-store","company-brain","competitive-landscape","content-engine","contract-analyzer","contract-redliner","coo","creating-financial-models","cto-onedrive","daily-briefing","daily-digest","datadog","designer","devkit","digital-products","dispatching-parallel-agents","distributed-tracing","doc-indexer","edgartools","employment-contract-templates","error-handling-patterns","eval-runner","executing-plans","fleet-dispatch","fleet-medic","fleet-telemetry","focus-group-loop","gdpr-data-handling","github-app","gmail","grant-tracker","growth-pr","heygen-video","incident-runbook-templates","innd-stock","ir-support","kb-memory","kpi-dashboard-design","legal","lifecycle-crm","live-walkthrough","m365-mail","market-sizing-analysis","monetization","paid-ads","partnerships","pci-compliance","pdf","plaid-banking","postmortem-writing","quickbooks","raise-ops","receiving-code-review","release-conductor","requesting-code-review","sast-configuration","scaffolder","screen-reader-testing","shark-tank","skills-discovery","slo-implementation","sql-optimization-patterns","startup-financial-modeling","storefront-cro","stripe-integration","subagent-driven-development","sunset-protocol","supply-chain-guard","systematic-debugging","telemetry-wiring","test-author","test-driven-development","threat-mitigation-mapping","vault-sync","verification-before-completion","voice-ops","wcag-audit-patterns","writing-plans","xero"];

export const PLUGINS: string[] = ["sunset-protocol"];

export const SKILLS_REPO = 'https://github.com/InnerScopeHearing/otchealth-claude-tools/tree/main/skills';
