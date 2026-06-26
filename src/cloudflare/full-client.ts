/**
 * Cloudflare FULL client — exhaustive coverage.
 * Self-contained: auth + request helper mirrors api-client.ts exactly.
 * Do NOT edit api-client.ts or write-client.ts.
 *
 * Covered resources:
 *   Zones, DNS (get/export/import), Cache purge, Page Rules,
 *   Firewall/WAF custom rules, Rate-limit rules, Redirect rules (bulk lists),
 *   Filters, Email Routing (settings/catch-all/DNS), Workers Routes, DNSSEC.
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// ── Error ─────────────────────────────────────────────────────────────────────

export class CloudflareFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'CloudflareFullError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireToken(): string {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new CloudflareFullError({
      code: 'cloudflare_not_configured',
      status: 0,
      message: 'CLOUDFLARE_API_TOKEN is not set.',
      nextStep: 'Add CLOUDFLARE_API_TOKEN to the MCP server environment.',
    });
  }
  return env.CLOUDFLARE_API_TOKEN;
}

function resolveZoneId(zoneId?: string): string {
  const id = zoneId ?? env.CLOUDFLARE_ZONE_ID;
  if (!id) {
    throw new CloudflareFullError({
      code: 'cloudflare_zone_not_configured',
      status: 0,
      message: 'zone_id not supplied and CLOUDFLARE_ZONE_ID is not set.',
      nextStep: 'Pass zone_id explicitly or set CLOUDFLARE_ZONE_ID in the environment.',
    });
  }
  return id;
}

const BASE = 'https://api.cloudflare.com/client/v4';

// ── Core HTTP helper ──────────────────────────────────────────────────────────

async function cf<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const token = requireToken();
  let url = `${BASE}${path}`;
  if (opts?.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  const { statusCode, body: respBody } = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 200 && statusCode < 300 && (data.success !== false)) {
    return data as T;
  }
  if (!data.success && statusCode >= 400) {
    const errMsg = data.errors?.[0]?.message ?? `HTTP ${statusCode}`;
    const errCode = data.errors?.[0]?.code ?? statusCode;
    throw new CloudflareFullError({
      code: `cloudflare_${errCode}`,
      status: statusCode,
      message: errMsg,
      nextStep: 'Check the Cloudflare API response for details.',
      upstream: data.errors,
    });
  }
  return data as T;
}

async function cfText(method: string, path: string, opts?: { body?: unknown; contentType?: string }): Promise<string> {
  const token = requireToken();
  const url = `${BASE}${path}`;
  const { statusCode, body: respBody } = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': opts?.contentType ?? 'application/json',
    },
    body: opts?.body !== undefined
      ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      : undefined,
  });
  const text = await respBody.text();
  if (statusCode >= 400) {
    throw new CloudflareFullError({
      code: `cloudflare_http_${statusCode}`,
      status: statusCode,
      message: `HTTP ${statusCode}: ${text.slice(0, 200)}`,
      nextStep: 'Check Cloudflare API response for details.',
    });
  }
  return text;
}

// ════════════════════════════════════════════════════════════════════════════
// ZONES
// ════════════════════════════════════════════════════════════════════════════

/** GET /zones — list zones on the account */
export async function listZones(opts?: { name?: string; status?: string; per_page?: number; page?: number }): Promise<any[]> {
  const resp = await cf<{ result: any[] }>('GET', '/zones', { query: opts as any });
  return resp.result ?? [];
}

/** GET /zones/{zone} — get a single zone */
export async function getZone(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}`);
  return resp.result;
}

/** GET /zones/{zone}/settings — all settings for a zone */
export async function getZoneSettings(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/settings`);
  return resp.result ?? [];
}

/** PATCH /zones/{zone}/settings/{setting_id} — update one setting */
export async function updateZoneSetting(
  settingId: string,
  value: unknown,
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('PATCH', `/zones/${id}/settings/${settingId}`, {
    body: { value },
  });
  return resp.result;
}

// ════════════════════════════════════════════════════════════════════════════
// DNS (extras — list/create/update/delete already in api-client/write-client)
// ════════════════════════════════════════════════════════════════════════════

/** GET /zones/{zone}/dns_records/{record_id} — get a single DNS record */
export async function getDnsRecord(recordId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/dns_records/${recordId}`);
  return resp.result;
}

/** GET /zones/{zone}/dns_records/export — zone file (BIND) */
export async function exportDnsRecords(zoneId?: string): Promise<string> {
  const id = resolveZoneId(zoneId);
  return cfText('GET', `/zones/${id}/dns_records/export`);
}

/** POST /zones/{zone}/dns_records/import — import BIND zone file */
export async function importDnsRecords(
  bindContent: string,
  proxied?: boolean,
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  // The Cloudflare import endpoint accepts multipart/form-data with a 'file' field.
  // We use the raw text endpoint approach via a plain POST with form body.
  const boundary = '----CFImportBoundary';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="records.txt"',
    'Content-Type: text/plain',
    '',
    bindContent,
    ...(proxied !== undefined ? [
      `--${boundary}`,
      'Content-Disposition: form-data; name="proxied"',
      '',
      String(proxied),
    ] : []),
    `--${boundary}--`,
  ].join('\r\n');
  const token = requireToken();
  const url = `${BASE}/zones/${id}/dns_records/import`;
  const { statusCode, body: respBody } = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400 || data.success === false) {
    const errMsg = data.errors?.[0]?.message ?? `HTTP ${statusCode}`;
    throw new CloudflareFullError({
      code: `cloudflare_import_${statusCode}`,
      status: statusCode,
      message: errMsg,
      nextStep: 'Verify the BIND zone file format.',
      upstream: data.errors,
    });
  }
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE PURGE
// ════════════════════════════════════════════════════════════════════════════

/** POST /zones/{zone}/purge_cache — purge everything */
export async function purgeEverything(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  return cf('POST', `/zones/${id}/purge_cache`, { body: { purge_everything: true } });
}

/** POST /zones/{zone}/purge_cache — purge by URL list */
export async function purgeByUrls(urls: string[], zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  return cf('POST', `/zones/${id}/purge_cache`, { body: { files: urls } });
}

/** POST /zones/{zone}/purge_cache — purge by cache tags */
export async function purgeByCacheTags(tags: string[], zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  return cf('POST', `/zones/${id}/purge_cache`, { body: { tags } });
}

// ════════════════════════════════════════════════════════════════════════════
// PAGE RULES
// ════════════════════════════════════════════════════════════════════════════

/** GET /zones/{zone}/pagerules */
export async function listPageRules(opts?: { status?: string; order?: string }, zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/pagerules`, { query: opts as any });
  return resp.result ?? [];
}

/** GET /zones/{zone}/pagerules/{id} */
export async function getPageRule(ruleId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/pagerules/${ruleId}`);
  return resp.result;
}

/** POST /zones/{zone}/pagerules */
export async function createPageRule(
  targets: { target: string; constraint: { operator: string; value: string } }[],
  actions: { id: string; value?: unknown }[],
  opts?: { priority?: number; status?: string },
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('POST', `/zones/${id}/pagerules`, {
    body: { targets, actions, priority: opts?.priority ?? 1, status: opts?.status ?? 'active' },
  });
  return resp.result;
}

/** PUT /zones/{zone}/pagerules/{id} — full replacement */
export async function updatePageRule(
  ruleId: string,
  targets: { target: string; constraint: { operator: string; value: string } }[],
  actions: { id: string; value?: unknown }[],
  opts?: { priority?: number; status?: string },
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('PUT', `/zones/${id}/pagerules/${ruleId}`, {
    body: { targets, actions, priority: opts?.priority ?? 1, status: opts?.status ?? 'active' },
  });
  return resp.result;
}

/** DELETE /zones/{zone}/pagerules/{id} */
export async function deletePageRule(ruleId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  return cf('DELETE', `/zones/${id}/pagerules/${ruleId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// FIREWALL / WAF CUSTOM RULES  (Ruleset-based, cf.rulesets v4 API)
// ════════════════════════════════════════════════════════════════════════════

const FIREWALL_PHASE = 'http_request_firewall_custom';

/** GET /zones/{zone}/rulesets — find the firewall custom ruleset */
export async function listFirewallRules(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/rulesets`);
  const rulesets: any[] = resp.result ?? [];
  const fw = rulesets.find((r: any) => r.phase === FIREWALL_PHASE);
  if (!fw) return [];
  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${fw.id}`);
  return detail.result?.rules ?? [];
}

/** GET single firewall rule by rule id within the firewall ruleset */
export async function getFirewallRule(ruleId: string, zoneId?: string): Promise<any> {
  const rules = await listFirewallRules(zoneId);
  const rule = rules.find((r: any) => r.id === ruleId);
  if (!rule) {
    throw new CloudflareFullError({
      code: 'cloudflare_rule_not_found',
      status: 404,
      message: `Firewall rule ${ruleId} not found in the firewall custom ruleset.`,
      nextStep: 'Use cloudflare_firewall_rule_list to see available rule IDs.',
    });
  }
  return rule;
}

/** Upsert a rule into the firewall custom ruleset (POST to create the ruleset if absent, then append rule). */
export async function createFirewallRule(
  expression: string,
  action: string,
  description: string,
  enabled: boolean,
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  // Locate or create the firewall ruleset for this zone.
  const rulesets = await cf<{ result: any[] }>('GET', `/zones/${id}/rulesets`);
  let fw = (rulesets.result ?? []).find((r: any) => r.phase === FIREWALL_PHASE);

  if (!fw) {
    // Create the ruleset first.
    const created = await cf<{ result: any }>('POST', `/zones/${id}/rulesets`, {
      body: { name: 'Zone Firewall Custom Rules', kind: 'zone', phase: FIREWALL_PHASE, rules: [] },
    });
    fw = created.result;
  }

  // Fetch current rules to append.
  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${fw.id}`);
  const existingRules: any[] = detail.result?.rules ?? [];
  const newRule = { expression, action, description, enabled };
  const updated = await cf<{ result: any }>('PUT', `/zones/${id}/rulesets/${fw.id}`, {
    body: { rules: [...existingRules, newRule] },
  });
  const rules: any[] = updated.result?.rules ?? [];
  return rules[rules.length - 1];
}

/** PATCH a single rule within the firewall ruleset */
export async function updateFirewallRule(
  ruleId: string,
  patch: { expression?: string; action?: string; description?: string; enabled?: boolean },
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  const rulesets = await cf<{ result: any[] }>('GET', `/zones/${id}/rulesets`);
  const fw = (rulesets.result ?? []).find((r: any) => r.phase === FIREWALL_PHASE);
  if (!fw) throw new CloudflareFullError({ code: 'cloudflare_ruleset_not_found', status: 404, message: 'Firewall ruleset not found.', nextStep: 'Create a firewall rule first.' });

  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${fw.id}`);
  const rules: any[] = (detail.result?.rules ?? []).map((r: any) =>
    r.id === ruleId ? { ...r, ...patch } : r,
  );
  const updated = await cf<{ result: any }>('PUT', `/zones/${id}/rulesets/${fw.id}`, { body: { rules } });
  return (updated.result?.rules ?? []).find((r: any) => r.id === ruleId);
}

/** Delete a rule from the firewall ruleset */
export async function deleteFirewallRule(ruleId: string, zoneId?: string): Promise<{ deleted: boolean }> {
  const id = resolveZoneId(zoneId);
  const rulesets = await cf<{ result: any[] }>('GET', `/zones/${id}/rulesets`);
  const fw = (rulesets.result ?? []).find((r: any) => r.phase === FIREWALL_PHASE);
  if (!fw) throw new CloudflareFullError({ code: 'cloudflare_ruleset_not_found', status: 404, message: 'Firewall ruleset not found.', nextStep: 'Create a firewall rule first.' });

  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${fw.id}`);
  const rules: any[] = (detail.result?.rules ?? []).filter((r: any) => r.id !== ruleId);
  await cf('PUT', `/zones/${id}/rulesets/${fw.id}`, { body: { rules } });
  return { deleted: true };
}

// ════════════════════════════════════════════════════════════════════════════
// RATE-LIMIT RULES  (Ruleset phase: http_ratelimit)
// ════════════════════════════════════════════════════════════════════════════

const RATELIMIT_PHASE = 'http_ratelimit';

async function getRatelimitRuleset(zoneId: string): Promise<any | null> {
  const rulesets = await cf<{ result: any[] }>('GET', `/zones/${zoneId}/rulesets`);
  return (rulesets.result ?? []).find((r: any) => r.phase === RATELIMIT_PHASE) ?? null;
}

export async function listRateLimitRules(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const rs = await getRatelimitRuleset(id);
  if (!rs) return [];
  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${rs.id}`);
  return detail.result?.rules ?? [];
}

export async function createRateLimitRule(
  expression: string,
  action: string,
  period: number,
  requestsPerPeriod: number,
  description: string,
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  let rs = await getRatelimitRuleset(id);
  if (!rs) {
    const created = await cf<{ result: any }>('POST', `/zones/${id}/rulesets`, {
      body: { name: 'Zone Rate Limit Rules', kind: 'zone', phase: RATELIMIT_PHASE, rules: [] },
    });
    rs = created.result;
  }
  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${rs.id}`);
  const existingRules: any[] = detail.result?.rules ?? [];
  const newRule = {
    expression,
    action,
    description,
    ratelimit: { period, requests_per_period: requestsPerPeriod },
  };
  const updated = await cf<{ result: any }>('PUT', `/zones/${id}/rulesets/${rs.id}`, {
    body: { rules: [...existingRules, newRule] },
  });
  const rules: any[] = updated.result?.rules ?? [];
  return rules[rules.length - 1];
}

export async function deleteRateLimitRule(ruleId: string, zoneId?: string): Promise<{ deleted: boolean }> {
  const id = resolveZoneId(zoneId);
  const rs = await getRatelimitRuleset(id);
  if (!rs) throw new CloudflareFullError({ code: 'cloudflare_ruleset_not_found', status: 404, message: 'Rate-limit ruleset not found.', nextStep: 'Create a rate-limit rule first.' });
  const detail = await cf<{ result: any }>('GET', `/zones/${id}/rulesets/${rs.id}`);
  const rules: any[] = (detail.result?.rules ?? []).filter((r: any) => r.id !== ruleId);
  await cf('PUT', `/zones/${id}/rulesets/${rs.id}`, { body: { rules } });
  return { deleted: true };
}

// ════════════════════════════════════════════════════════════════════════════
// REDIRECT RULES — Bulk Redirects (Account-level lists)
// ════════════════════════════════════════════════════════════════════════════

/** GET /accounts/{account}/rules/lists — list all bulk redirect lists */
export async function listRedirectLists(accountId: string): Promise<any[]> {
  const resp = await cf<{ result: any[] }>('GET', `/accounts/${accountId}/rules/lists`);
  return (resp.result ?? []).filter((l: any) => l.kind === 'redirect');
}

/** GET /accounts/{account}/rules/lists/{list_id}/items */
export async function getRedirectListItems(accountId: string, listId: string): Promise<any[]> {
  const resp = await cf<{ result: any[] }>('GET', `/accounts/${accountId}/rules/lists/${listId}/items`);
  return resp.result ?? [];
}

/** POST /accounts/{account}/rules/lists/{list_id}/items — add redirect entries */
export async function addRedirectListItems(
  accountId: string,
  listId: string,
  items: { redirect: { source_url: string; target_url: string; status_code?: number; include_subdomains?: boolean; preserve_path_suffix?: boolean } }[],
): Promise<any> {
  return cf('POST', `/accounts/${accountId}/rules/lists/${listId}/items`, { body: items });
}

/** DELETE /accounts/{account}/rules/lists/{list_id}/items */
export async function deleteRedirectListItems(
  accountId: string,
  listId: string,
  itemIds: string[],
): Promise<any> {
  return cf('DELETE', `/accounts/${accountId}/rules/lists/${listId}/items`, {
    body: { items: itemIds.map(id => ({ id })) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// FILTERS  (legacy expression filter API, still widely used)
// ════════════════════════════════════════════════════════════════════════════

export async function listFilters(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/filters`);
  return resp.result ?? [];
}

export async function getFilter(filterId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/filters/${filterId}`);
  return resp.result;
}

export async function createFilter(expression: string, description?: string, paused?: boolean, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('POST', `/zones/${id}/filters`, {
    body: [{ expression, description, paused: paused ?? false }],
  });
  return resp.result?.[0];
}

export async function updateFilter(filterId: string, expression: string, description?: string, paused?: boolean, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('PUT', `/zones/${id}/filters/${filterId}`, {
    body: { id: filterId, expression, description, paused: paused ?? false },
  });
  return resp.result;
}

export async function deleteFilter(filterId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  return cf('DELETE', `/zones/${id}/filters/${filterId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// EMAIL ROUTING — extras (get-settings, enable/disable, catch-all)
// ════════════════════════════════════════════════════════════════════════════

export async function getEmailRoutingSettings(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/email/routing`);
  return resp.result;
}

export async function enableEmailRouting(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('POST', `/zones/${id}/email/routing/enable`);
  return resp.result;
}

export async function disableEmailRouting(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('POST', `/zones/${id}/email/routing/disable`);
  return resp.result;
}

export async function getEmailCatchAll(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/email/routing/rules/catch_all`);
  return resp.result;
}

export async function updateEmailCatchAll(
  enabled: boolean,
  action: 'drop' | 'forward' | 'worker',
  forwardTo?: string,
  zoneId?: string,
): Promise<any> {
  const id = resolveZoneId(zoneId);
  const actions: any[] = action === 'forward' && forwardTo
    ? [{ type: 'forward', value: [forwardTo] }]
    : [{ type: action }];
  const resp = await cf<{ result: any }>('PUT', `/zones/${id}/email/routing/rules/catch_all`, {
    body: { enabled, matchers: [{ type: 'all' }], actions },
  });
  return resp.result;
}

export async function getEmailRoutingDnsRecords(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/email/routing/dns`);
  return resp.result ?? [];
}

// ════════════════════════════════════════════════════════════════════════════
// WORKERS ROUTES
// ════════════════════════════════════════════════════════════════════════════

export async function listWorkersRoutes(zoneId?: string): Promise<any[]> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any[] }>('GET', `/zones/${id}/workers/routes`);
  return resp.result ?? [];
}

export async function getWorkersRoute(routeId: string, zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/workers/routes/${routeId}`);
  return resp.result;
}

// ════════════════════════════════════════════════════════════════════════════
// DNSSEC
// ════════════════════════════════════════════════════════════════════════════

export async function getDnssec(zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('GET', `/zones/${id}/dnssec`);
  return resp.result;
}

export async function updateDnssec(status: 'active' | 'disabled', zoneId?: string): Promise<any> {
  const id = resolveZoneId(zoneId);
  const resp = await cf<{ result: any }>('PATCH', `/zones/${id}/dnssec`, { body: { status } });
  return resp.result;
}
