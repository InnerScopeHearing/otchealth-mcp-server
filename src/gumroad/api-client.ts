import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export class GumroadApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GumroadApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.GUMROAD_ACCESS_TOKEN) {
    throw new GumroadApiError({
      code: 'gumroad_not_configured',
      status: 0,
      message: 'GUMROAD_ACCESS_TOKEN is not set.',
      nextStep: 'Add GUMROAD_ACCESS_TOKEN to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.GUMROAD_ACCESS_TOKEN;
}

const BASE = 'https://api.gumroad.com/v2';

async function gumroadRequest<T = any>(
  path: string,
  opts?: { query?: Record<string, string | number | undefined> },
): Promise<T> {
  const key = requireKey();
  // Gumroad v2 authenticates via the access_token parameter.
  const params = new URLSearchParams();
  params.set('access_token', key);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const url = `${BASE}${path}?${params.toString()}`;

  const { statusCode, body: respBody } = await request(url, { method: 'GET' });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400 || data?.success === false) {
    throw new GumroadApiError({
      code: `gumroad_${statusCode}`,
      status: statusCode,
      message: data?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Gumroad API response. Ensure GUMROAD_ACCESS_TOKEN is valid (Settings > Advanced > Applications).',
      upstream: data,
    });
  }
  return data as T;
}

// ----- Read-only endpoints -----

export async function listProducts(): Promise<{ success: boolean; products: any[] }> {
  return gumroadRequest('/products');
}

export async function listSales(opts?: {
  after?: string;
  before?: string;
  page_key?: string;
}): Promise<{ success: boolean; sales: any[]; next_page_url?: string; next_page_key?: string }> {
  return gumroadRequest('/sales', {
    query: { after: opts?.after, before: opts?.before, page_key: opts?.page_key },
  });
}
