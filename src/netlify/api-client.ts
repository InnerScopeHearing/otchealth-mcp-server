import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class NetlifyApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'NetlifyApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.NETLIFY_AUTH_TOKEN) {
    throw new NetlifyApiError({
      code: 'netlify_not_configured',
      status: 0,
      message: 'NETLIFY_AUTH_TOKEN is not set.',
      nextStep: 'Add NETLIFY_AUTH_TOKEN to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.NETLIFY_AUTH_TOKEN;
}

const BASE = 'https://api.netlify.com/api/v1';

async function netlifyRequest<T = unknown>(
  path: string,
  opts?: { query?: Record<string, string | number | undefined> },
): Promise<T> {
  const key = requireKey();
  let url = `${BASE}${path}`;
  if (opts?.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new NetlifyApiError({
      code: `netlify_${statusCode}`,
      status: statusCode,
      message: data?.message ?? data?.error ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Netlify API response. Ensure NETLIFY_AUTH_TOKEN is valid and has access to the site.',
      upstream: data,
    });
  }
  return data as T;
}

// ----- Read-only endpoints -----

export async function listSites(opts?: { name?: string; per_page?: number }): Promise<any[]> {
  return netlifyRequest('/sites', {
    query: { filter: 'all', name: opts?.name, per_page: opts?.per_page },
  });
}

export async function listSiteDeploys(siteId: string, opts?: { per_page?: number }): Promise<any[]> {
  return netlifyRequest(`/sites/${encodeURIComponent(siteId)}/deploys`, {
    query: { per_page: opts?.per_page },
  });
}

export async function getDeploy(deployId: string): Promise<any> {
  return netlifyRequest(`/deploys/${encodeURIComponent(deployId)}`);
}
