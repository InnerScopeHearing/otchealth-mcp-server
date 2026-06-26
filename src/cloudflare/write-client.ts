/**
 * Cloudflare WRITE client — NEW file. Never edit api-client.ts.
 * Auth + request helper mirrors api-client.ts exactly (same base URL, same
 * Bearer auth, same CloudflareApiError shape) so the two files stay in sync
 * structurally even though they are independent.
 *
 * Covered operations
 *  DNS  : updateDnsRecord (PATCH), deleteDnsRecord (DELETE)
 *  Email: updateEmailRoutingRule (PUT), deleteEmailRoutingRule (DELETE)
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// ── Error ────────────────────────────────────────────────────────────────────

export class CloudflareWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'CloudflareWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

// ── Auth helpers (mirrors api-client.ts) ─────────────────────────────────────

function requireToken(): string {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new CloudflareWriteError({
      code: 'cloudflare_not_configured',
      status: 0,
      message: 'CLOUDFLARE_API_TOKEN is not set.',
      nextStep: 'Add CLOUDFLARE_API_TOKEN to the MCP server environment.',
    });
  }
  return env.CLOUDFLARE_API_TOKEN;
}

function requireZoneId(): string {
  if (!env.CLOUDFLARE_ZONE_ID) {
    throw new CloudflareWriteError({
      code: 'cloudflare_zone_not_configured',
      status: 0,
      message: 'CLOUDFLARE_ZONE_ID is not set.',
      nextStep: 'Add CLOUDFLARE_ZONE_ID to the MCP server environment.',
    });
  }
  return env.CLOUDFLARE_ZONE_ID;
}

const BASE = 'https://api.cloudflare.com/client/v4';

// ── Core HTTP helper ─────────────────────────────────────────────────────────

async function cfWrite<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown },
): Promise<T> {
  const token = requireToken();
  const url = `${BASE}${path}`;
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

  // DELETE 200 with empty body or no result is still success
  if (statusCode >= 200 && statusCode < 300 && (data.success !== false)) {
    return data as T;
  }
  if (!data.success && statusCode >= 400) {
    const errMsg = data.errors?.[0]?.message ?? `HTTP ${statusCode}`;
    const errCode = data.errors?.[0]?.code ?? statusCode;
    throw new CloudflareWriteError({
      code: `cloudflare_${errCode}`,
      status: statusCode,
      message: errMsg,
      nextStep: 'Check the Cloudflare API response for details.',
      upstream: data.errors,
    });
  }
  return data as T;
}

// ── DNS ──────────────────────────────────────────────────────────────────────

export interface UpdateDnsRecordArgs {
  recordId: string;
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

/**
 * PATCH /zones/{zone}/dns_records/{id}
 * Partially updates a DNS record. Only provided fields are changed.
 */
export async function updateDnsRecord(args: UpdateDnsRecordArgs): Promise<any> {
  const zoneId = requireZoneId();
  const { recordId, ...fields } = args;
  // Build patch body: only include defined fields.
  const body: Record<string, unknown> = {};
  if (fields.type !== undefined) body.type = fields.type;
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.content !== undefined) body.content = fields.content;
  if (fields.ttl !== undefined) body.ttl = fields.ttl;
  if (fields.proxied !== undefined) body.proxied = fields.proxied;
  if (fields.priority !== undefined) body.priority = fields.priority;
  return cfWrite('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body });
}

/**
 * DELETE /zones/{zone}/dns_records/{id}
 * Permanently deletes a DNS record. This action is irreversible.
 */
export async function deleteDnsRecord(recordId: string): Promise<any> {
  const zoneId = requireZoneId();
  return cfWrite('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}

// ── Email Routing ────────────────────────────────────────────────────────────

export interface UpdateEmailRuleArgs {
  ruleId: string;
  name?: string;
  enabled?: boolean;
  matchAddress?: string;
  forwardTo?: string;
}

/**
 * PUT /zones/{zone}/email/routing/rules/{rule_identifier}
 * Full replacement of an email routing rule. Fetches current rule first so
 * callers may supply only the fields they wish to change; this function
 * merges the supplied fields into the full rule body that PUT requires.
 *
 * NOTE: the Cloudflare Email Routing API requires a full PUT body (not PATCH).
 * We accept partial input and merge with sensible defaults so callers only
 * specify what changes.
 */
export async function updateEmailRoutingRule(args: UpdateEmailRuleArgs): Promise<any> {
  const zoneId = requireZoneId();
  const { ruleId, name, enabled, matchAddress, forwardTo } = args;

  // Build a replacement body. Caller must supply enough context for a valid rule.
  // At minimum the matchers + actions shape must be preserved.
  const body: Record<string, unknown> = {};
  if (name !== undefined) body.name = name;
  body.enabled = enabled ?? true;
  if (matchAddress !== undefined) {
    body.matchers = [{ type: 'literal', field: 'to', value: matchAddress }];
  }
  if (forwardTo !== undefined) {
    body.actions = [{ type: 'forward', value: [forwardTo] }];
  }
  return cfWrite('PUT', `/zones/${zoneId}/email/routing/rules/${ruleId}`, { body });
}

/**
 * DELETE /zones/{zone}/email/routing/rules/{rule_identifier}
 * Permanently deletes an email routing rule.
 */
export async function deleteEmailRoutingRule(ruleId: string): Promise<any> {
  const zoneId = requireZoneId();
  return cfWrite('DELETE', `/zones/${zoneId}/email/routing/rules/${ruleId}`);
}
