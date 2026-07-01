import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class StripeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'StripeApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeApiError({
      code: 'stripe_not_configured',
      status: 0,
      message: 'STRIPE_SECRET_KEY is not set.',
      nextStep: 'Add STRIPE_SECRET_KEY to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.STRIPE_SECRET_KEY;
}

const BASE = 'https://api.stripe.com';

async function stripeRequest<T = unknown>(
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

  const auth = Buffer.from(`${key}:`).toString('base64');
  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new StripeApiError({
      code: `stripe_${data.error?.type ?? statusCode}`,
      status: statusCode,
      message: data.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check Stripe API error details. Ensure STRIPE_SECRET_KEY is valid.',
      upstream: data.error,
    });
  }
  return data as T;
}

// ----- Read-only endpoints -----

export async function getBalance(): Promise<any> {
  return stripeRequest('/v1/balance');
}

export async function listCharges(opts?: {
  limit?: number;
  customer?: string;
  created_gte?: number;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeRequest('/v1/charges', {
    query: { limit: opts?.limit, customer: opts?.customer, 'created[gte]': opts?.created_gte },
  });
}

export async function getCharge(chargeId: string): Promise<any> {
  return stripeRequest(`/v1/charges/${encodeURIComponent(chargeId)}`);
}

export async function listCustomers(opts?: {
  limit?: number;
  email?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeRequest('/v1/customers', {
    query: { limit: opts?.limit, email: opts?.email },
  });
}

export async function listPaymentIntents(opts?: {
  limit?: number;
  customer?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeRequest('/v1/payment_intents', {
    query: { limit: opts?.limit, customer: opts?.customer },
  });
}

export async function listProducts(opts?: {
  limit?: number;
  active?: boolean;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeRequest('/v1/products', {
    query: { limit: opts?.limit, active: opts?.active !== undefined ? String(opts.active) : undefined },
  });
}

export async function listSubscriptions(opts?: {
  limit?: number;
  customer?: string;
  status?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeRequest('/v1/subscriptions', {
    query: { limit: opts?.limit, customer: opts?.customer, status: opts?.status },
  });
}
