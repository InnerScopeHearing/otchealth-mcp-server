/**
 * Capability Catalog manifest (the "deep dive" Matt asked for).
 *
 * For each upstream service the gateway can reach, this hand-maintained manifest
 * lists the KNOWN upstream capabilities (drawn from each provider's published API
 * surface) with a `wired` flag: wired=true means a gateway tool exists for it;
 * wired=false means the capability is AVAILABLE-NOT-WIRED ("a feature on the
 * table"). This is the source data behind:
 *   - catalog_service_capabilities (per-service WIRED vs AVAILABLE-NOT-WIRED)
 *   - catalog_audit_unused (the cross-service AVAILABLE-NOT-WIRED report)
 *
 * When you wire a new tool, flip the matching capability `wired` to true (and add
 * `toolName`). When you learn a new upstream capability, add a row with
 * wired:false so it shows up in the unused report. Keep this honest: the value of
 * catalog_audit_unused depends on this list reflecting reality.
 *
 * `wired` here is the DECLARED intent. catalog_list_tools enumerates the tools
 * actually registered at runtime, so the two can be cross-checked.
 */

export type WriteClass = 'read' | 'write' | 'destructive';

export interface CapabilityEntry {
  /** Short stable capability id, unique within the service. */
  id: string;
  /** Human description of the upstream capability. */
  description: string;
  /** True if a gateway tool exposes this capability today. */
  wired: boolean;
  /** The gateway tool name, when wired. */
  toolName?: string;
  /** Read vs write vs destructive (informs gating expectations). */
  writeClass: WriteClass;
  /** Optional note: PHI carve-out, gating, securities firewall, TODO, etc. */
  note?: string;
}

export interface ServiceManifest {
  service: string;
  /** One-line description of the upstream + its role in the stack. */
  summary: string;
  /** Ring / compliance posture for the whole service. */
  ring: 'non-phi' | 'phi-carve-out' | 'securities-gated';
  capabilities: CapabilityEntry[];
}

export const CATALOG: ServiceManifest[] = [
  {
    service: 'customerio',
    summary: 'Customer.io lifecycle messaging (workspace 193366). App API reads + Track API writes + n8n-orchestrated writes.',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_newsletters', description: 'List newsletters/broadcasts.', wired: true, toolName: 'cio_list_newsletters', writeClass: 'read' },
      { id: 'get_newsletter', description: 'Get a newsletter by id.', wired: true, toolName: 'cio_get_newsletter', writeClass: 'read' },
      { id: 'get_newsletter_metrics', description: 'Newsletter delivery/open/click metrics.', wired: true, toolName: 'cio_get_newsletter_metrics', writeClass: 'read' },
      { id: 'get_newsletter_schedule', description: 'Newsletter schedule.', wired: true, toolName: 'cio_get_newsletter_schedule', writeClass: 'read' },
      { id: 'get_segment', description: 'Get a segment by id.', wired: true, toolName: 'cio_get_segment', writeClass: 'read' },
      { id: 'list_segment_people', description: 'List people in a segment.', wired: true, toolName: 'cio_list_segment_people', writeClass: 'read' },
      { id: 'get_customer', description: 'Get a customer profile.', wired: true, toolName: 'cio_get_customer', writeClass: 'read' },
      { id: 'get_template_or_content', description: 'Get a message template/content.', wired: true, toolName: 'cio_get_template_or_content', writeClass: 'read' },
      { id: 'get_broadcast_history', description: 'Broadcast history for a segment.', wired: true, toolName: 'cio_get_broadcast_history_for_segment', writeClass: 'read' },
      { id: 'track_event', description: 'Fire a Track API event.', wired: true, toolName: 'cio_track_event', writeClass: 'write', note: 'Event names allowlisted; defaults to dry_run.' },
      { id: 'update_customer_attributes', description: 'Update customer attributes.', wired: true, toolName: 'cio_update_customer_attributes', writeClass: 'write' },
      { id: 'update_newsletter_variant', description: 'Update a newsletter variant (n8n-orchestrated).', wired: true, toolName: 'cio_update_newsletter_variant', writeClass: 'write' },
      { id: 'duplicate_newsletter', description: 'Duplicate a newsletter (n8n-orchestrated).', wired: true, toolName: 'cio_duplicate_newsletter', writeClass: 'write' },
      { id: 'list_campaigns', description: 'List campaigns and their state.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'campaign_metrics', description: 'Per-campaign journey metrics.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'trigger_broadcast', description: 'Trigger an API-triggered broadcast.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; high-risk write, gate carefully.' },
    ],
  },
  {
    service: 'shopify',
    summary: 'Shopify Admin API for hearingassist.myshopify.com (otchealthmart.com storefront).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_products', description: 'List products + variants.', wired: true, toolName: 'shopify_list_products', writeClass: 'read' },
      { id: 'get_product', description: 'Get a product by id.', wired: true, toolName: 'shopify_get_product', writeClass: 'read' },
      { id: 'get_order', description: 'Get an order by id.', wired: true, toolName: 'shopify_get_order', writeClass: 'read' },
      { id: 'list_abandoned_checkouts', description: 'List abandoned checkouts.', wired: true, toolName: 'shopify_list_abandoned_checkouts', writeClass: 'read' },
      { id: 'list_orders', description: 'List orders with filters.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'list_customers', description: 'List customers (PII; log-redacted).', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'inventory_levels', description: 'Inventory levels per location.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; relevant to the 10,298-unit owned inventory.' },
      { id: 'update_product', description: 'Create/update a product or variant price.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; CRO lever, write-gated.' },
      { id: 'create_discount', description: 'Create a price rule / discount code.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED.' },
    ],
  },
  {
    service: 'intercom',
    summary: 'Intercom help-center + conversations (158 articles RAG-indexed for the voice agents).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_articles', description: 'List help-center articles.', wired: true, toolName: 'intercom_list_articles', writeClass: 'read' },
      { id: 'get_article', description: 'Get an article by id.', wired: true, toolName: 'intercom_get_article', writeClass: 'read' },
      { id: 'list_conversations', description: 'List support conversations.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; PII-heavy, redact on log.' },
      { id: 'search_contacts', description: 'Search contacts.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; PII.' },
      { id: 'create_article', description: 'Create/update a help article.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED.' },
    ],
  },
  {
    service: 'n8n',
    summary: 'Self-hosted n8n at automation.otchealth.app (production automation engine).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_workflows', description: 'List workflows.', wired: true, toolName: 'n8n_list_workflows', writeClass: 'read' },
      { id: 'get_execution', description: 'Get an execution by id.', wired: true, toolName: 'n8n_get_execution', writeClass: 'read' },
      { id: 'list_executions', description: 'List recent executions with status filter.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'get_workflow', description: 'Get a full workflow definition.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'activate_workflow', description: 'Activate/deactivate a workflow.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; ops write, gate.' },
      { id: 'trigger_webhook', description: 'Fire an HMAC-signed workflow webhook.', wired: false, writeClass: 'write', note: 'Handled by webhook-client; the orchestrated CIO writes use it.' },
    ],
  },
  {
    service: 'cloudflare',
    summary: 'Cloudflare DNS + email routing (PHI subdomains must stay DNS-only / gray cloud).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_dns_records', description: 'List DNS records for a zone.', wired: true, toolName: 'cloudflare_list_dns_records', writeClass: 'read', note: 'Tool presence verified at runtime via catalog_list_tools.' },
      { id: 'get_dns_record', description: 'Get a DNS record.', wired: true, toolName: 'cloudflare_get_dns_record', writeClass: 'read' },
      { id: 'list_email_routes', description: 'List email routing rules.', wired: true, toolName: 'cloudflare_list_email_routes', writeClass: 'read' },
      { id: 'create_dns_record', description: 'Create a DNS record.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; Matt-gated infra change.' },
      { id: 'purge_cache', description: 'Purge zone cache.', wired: false, writeClass: 'destructive', note: 'AVAILABLE-NOT-WIRED.' },
    ],
  },
  {
    service: 'graph',
    summary: 'Microsoft Graph (COO Outlook nervous system, mail/calendar).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_messages', description: 'List mailbox messages.', wired: true, toolName: 'graph_list_messages', writeClass: 'read', note: 'Tool presence verified at runtime.' },
      { id: 'list_events', description: 'List calendar events.', wired: true, toolName: 'graph_list_events', writeClass: 'read' },
      { id: 'send_mail', description: 'Send mail.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; gate.' },
    ],
  },
  {
    service: 'stripe',
    summary: 'Stripe (payments). Securities/compliance-sensitive; financial data.',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_charges', description: 'List charges.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; client present (src/stripe), no tool yet.' },
      { id: 'list_subscriptions', description: 'List subscriptions.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'list_customers', description: 'List Stripe customers.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; PII.' },
      { id: 'create_refund', description: 'Issue a refund.', wired: false, writeClass: 'write', note: 'AVAILABLE-NOT-WIRED; money-moving, high-risk gate.' },
    ],
  },
  {
    service: 'depot',
    summary: 'Depot macOS/Linux build acceleration (primary iOS pipeline; $5k grant).',
    ring: 'non-phi',
    capabilities: [
      { id: 'list_projects', description: 'List build projects.', wired: true, toolName: 'depot_list_projects', writeClass: 'read' },
      { id: 'get_project', description: 'Get a project by id.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED in tools; client method exists (getProject).' },
      { id: 'list_builds', description: 'List builds (project-scoped, status filter).', wired: true, toolName: 'depot_list_builds', writeClass: 'read' },
      { id: 'get_build', description: 'Get a build (status + logs summary).', wired: true, toolName: 'depot_get_build', writeClass: 'read' },
      { id: 'get_usage', description: 'Org/project usage + grant burn.', wired: true, toolName: 'depot_get_usage', writeClass: 'read', note: 'Usage RPC name not fully documented; client falls back project->org. See api-client TODO.' },
      { id: 'list_cache_usage', description: 'Build cache size/usage.', wired: true, toolName: 'depot_list_cache_usage', writeClass: 'read', note: 'Cache-usage RPC name uncertain; see api-client TODO.' },
      { id: 'reset_cache', description: 'Reset/purge a project build cache.', wired: true, toolName: 'depot_reset_cache', writeClass: 'destructive', note: 'GUARDED WRITE behind ENABLE_WRITE_TOOLS; reset RPC name uncertain, see api-client TODO.' },
      { id: 'list_tokens', description: 'List org/project API tokens.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED; sensitive, leave off the table deliberately.' },
      { id: 'list_runners', description: 'List/describe self-hosted runner config.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
      { id: 'list_registry_images', description: 'List Depot registry/ephemeral images.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED.' },
    ],
  },
  {
    service: 'posthog',
    summary: 'PostHog primary observability ($50k grant). METADATA ONLY through the gateway. PHI carve-out: MedReview project 468398 is PHI-hardened; no replay/recording/person data ever.',
    ring: 'phi-carve-out',
    capabilities: [
      { id: 'list_organizations', description: 'List organizations.', wired: false, writeClass: 'read', note: 'AVAILABLE-NOT-WIRED in tools; client method exists (listOrganizations).' },
      { id: 'list_projects', description: 'List projects (metadata).', wired: true, toolName: 'posthog_list_projects', writeClass: 'read' },
      { id: 'list_insights', description: 'List insights/funnels (definitions).', wired: true, toolName: 'posthog_list_insights', writeClass: 'read' },
      { id: 'get_insight', description: 'Get an insight (aggregate result metadata).', wired: true, toolName: 'posthog_get_insight', writeClass: 'read' },
      { id: 'list_feature_flags', description: 'List feature flags.', wired: true, toolName: 'posthog_list_feature_flags', writeClass: 'read' },
      { id: 'get_feature_flag', description: 'Get a feature flag.', wired: true, toolName: 'posthog_get_feature_flag', writeClass: 'read' },
      { id: 'list_experiments', description: 'List experiments.', wired: true, toolName: 'posthog_list_experiments', writeClass: 'read' },
      { id: 'list_annotations', description: 'List annotations.', wired: true, toolName: 'posthog_list_annotations', writeClass: 'read' },
      { id: 'list_cohorts', description: 'List cohort definitions (no membership).', wired: true, toolName: 'posthog_list_cohorts', writeClass: 'read' },
      { id: 'session_recordings', description: 'Session replays / recordings.', wired: false, writeClass: 'read', note: 'INTENTIONALLY NEVER WIRED. PHI carve-out + replay lockdown. Do not add.' },
      { id: 'query_events', description: 'Raw person-level event query (HogQL / events).', wired: false, writeClass: 'read', note: 'INTENTIONALLY NEVER WIRED. Person-level data; PHI carve-out. Do not add.' },
      { id: 'persons', description: 'Person-level profiles.', wired: false, writeClass: 'read', note: 'INTENTIONALLY NEVER WIRED. PHI carve-out. Do not add.' },
    ],
  },
];

export function getServiceManifest(service: string): ServiceManifest | undefined {
  const key = service.trim().toLowerCase();
  return CATALOG.find((s) => s.service === key);
}

export function listServiceNames(): string[] {
  return CATALOG.map((s) => s.service);
}
