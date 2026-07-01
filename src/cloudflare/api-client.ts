import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class CloudflareApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'CloudflareApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireToken(): string {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new CloudflareApiError({
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
    throw new CloudflareApiError({
      code: 'cloudflare_zone_not_configured',
      status: 0,
      message: 'CLOUDFLARE_ZONE_ID is not set.',
      nextStep: 'Add CLOUDFLARE_ZONE_ID to the MCP server environment.',
    });
  }
  return env.CLOUDFLARE_ZONE_ID;
}

const BASE = 'https://api.cloudflare.com/client/v4';

async function cfRequest<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, string | number | undefined> },
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
  // GET/DELETE-by-id here are idempotent (retries:1); POST/PATCH mutate zone
  // config, so those get retries:0 to avoid a duplicate write on a timeout.
  const retries = method === 'GET' ? 1 : 0;
  const res = await fetchWithBudget(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  }, { retries });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!data.success && statusCode >= 400) {
    const errMsg = data.errors?.[0]?.message ?? `HTTP ${statusCode}`;
    const errCode = data.errors?.[0]?.code ?? statusCode;
    throw new CloudflareApiError({
      code: `cloudflare_${errCode}`,
      status: statusCode,
      message: errMsg,
      nextStep: 'Check the Cloudflare API response for details.',
      upstream: data.errors,
    });
  }
  return data as T;
}

// ----- Email Routing -----

export async function listEmailRoutingDestinations(): Promise<any[]> {
  const zoneId = requireZoneId();
  const resp = await cfRequest<{ result: any[] }>('GET', `/zones/${zoneId}/email/routing/addresses`);
  return resp.result ?? [];
}

export async function addEmailRoutingDestination(email: string): Promise<any> {
  const zoneId = requireZoneId();
  return cfRequest('POST', `/zones/${zoneId}/email/routing/addresses`, { body: { email } });
}

export async function listEmailRoutingRules(): Promise<any[]> {
  const zoneId = requireZoneId();
  const resp = await cfRequest<{ result: any[] }>('GET', `/zones/${zoneId}/email/routing/rules`);
  return resp.result ?? [];
}

export async function createEmailRoutingRule(
  name: string,
  matchAddress: string,
  forwardTo: string,
): Promise<any> {
  const zoneId = requireZoneId();
  return cfRequest('POST', `/zones/${zoneId}/email/routing/rules`, {
    body: {
      name,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: matchAddress }],
      actions: [{ type: 'forward', value: [forwardTo] }],
    },
  });
}

export async function deleteEmailRoutingRule(ruleId: string): Promise<any> {
  const zoneId = requireZoneId();
  return cfRequest('DELETE', `/zones/${zoneId}/email/routing/rules/${ruleId}`);
}

// ----- DNS -----

export async function listDnsRecords(opts?: {
  type?: string;
  name?: string;
  per_page?: number;
}): Promise<any[]> {
  const zoneId = requireZoneId();
  const resp = await cfRequest<{ result: any[] }>('GET', `/zones/${zoneId}/dns_records`, {
    query: opts as any,
  });
  return resp.result ?? [];
}

export async function createDnsRecord(
  type: string,
  name: string,
  content: string,
  opts?: { ttl?: number; proxied?: boolean; priority?: number },
): Promise<any> {
  const zoneId = requireZoneId();
  return cfRequest('POST', `/zones/${zoneId}/dns_records`, {
    body: { type, name, content, ttl: opts?.ttl ?? 1, proxied: opts?.proxied ?? false, priority: opts?.priority },
  });
}

export async function deleteDnsRecord(recordId: string): Promise<any> {
  const zoneId = requireZoneId();
  return cfRequest('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}
