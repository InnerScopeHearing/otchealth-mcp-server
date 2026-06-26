/**
 * Stripe write-side API client.
 *
 * Self-contained: owns its own form-encoded POST/DELETE helper and StripeWriteError.
 * Auth: Basic auth with STRIPE_SECRET_KEY (same pattern as api-client.ts).
 * Stripe POST bodies are application/x-www-form-urlencoded; nested keys use
 * bracket notation e.g. items[0][price].
 *
 * NEVER import from api-client.ts — write-client is intentionally standalone so
 * write operations can be audited and gated independently.
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class StripeWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: {
    code: string;
    status: number;
    message: string;
    nextStep: string;
    upstream?: unknown;
  }) {
    super(args.message);
    this.name = 'StripeWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireKey(): string {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeWriteError({
      code: 'stripe_not_configured',
      status: 0,
      message: 'STRIPE_SECRET_KEY is not set.',
      nextStep:
        'Add STRIPE_SECRET_KEY to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.STRIPE_SECRET_KEY;
}

const BASE = 'https://api.stripe.com';

/**
 * Flatten a nested object into Stripe's bracket-notation form params.
 * e.g. { items: [{ price: 'price_xxx', quantity: 1 }] }
 *   -> "items[0][price]=price_xxx&items[0][quantity]=1"
 */
function flattenParams(
  obj: Record<string, unknown>,
  prefix = '',
  params = new URLSearchParams(),
): URLSearchParams {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        const idxKey = `${fullKey}[${idx}]`;
        if (typeof item === 'object' && item !== null) {
          flattenParams(item as Record<string, unknown>, idxKey, params);
        } else {
          params.append(idxKey, String(item));
        }
      });
    } else if (typeof value === 'object') {
      flattenParams(value as Record<string, unknown>, fullKey, params);
    } else {
      params.append(fullKey, String(value));
    }
  }
  return params;
}

async function stripeWrite<T = unknown>(
  path: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<T> {
  const key = requireKey();
  const url = `${BASE}${path}`;
  const auth = Buffer.from(`${key}:`).toString('base64');

  const params = body ? flattenParams(body) : new URLSearchParams();
  const bodyStr = params.toString();

  const { statusCode, body: respBody } = await request(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: bodyStr || undefined,
  });

  const text = await respBody.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (statusCode >= 400) {
    throw new StripeWriteError({
      code: `stripe_${data?.error?.type ?? statusCode}`,
      status: statusCode,
      message: data?.error?.message ?? `HTTP ${statusCode}`,
      nextStep:
        'Check Stripe API error details. Ensure STRIPE_SECRET_KEY is valid and has write permissions.',
      upstream: data?.error,
    });
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

// ---- Refunds ---------------------------------------------------------------

export interface CreateRefundParams {
  charge?: string;
  payment_intent?: string;
  amount?: number; // in cents
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Record<string, string>;
}

export async function createRefund(params: CreateRefundParams): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.charge) body.charge = params.charge;
  if (params.payment_intent) body.payment_intent = params.payment_intent;
  if (params.amount !== undefined) body.amount = params.amount;
  if (params.reason) body.reason = params.reason;
  if (params.metadata) body.metadata = params.metadata;
  return stripeWrite('/v1/refunds', 'POST', body);
}

// ---- Customers -------------------------------------------------------------

export interface CreateCustomerParams {
  email?: string;
  name?: string;
  phone?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export async function createCustomer(params: CreateCustomerParams): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.email) body.email = params.email;
  if (params.name) body.name = params.name;
  if (params.phone) body.phone = params.phone;
  if (params.description) body.description = params.description;
  if (params.metadata) body.metadata = params.metadata;
  return stripeWrite('/v1/customers', 'POST', body);
}

export interface UpdateCustomerParams {
  customerId: string;
  email?: string;
  name?: string;
  phone?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export async function updateCustomer(params: UpdateCustomerParams): Promise<any> {
  const { customerId, ...rest } = params;
  const body: Record<string, unknown> = {};
  if (rest.email) body.email = rest.email;
  if (rest.name) body.name = rest.name;
  if (rest.phone) body.phone = rest.phone;
  if (rest.description) body.description = rest.description;
  if (rest.metadata) body.metadata = rest.metadata;
  return stripeWrite(`/v1/customers/${encodeURIComponent(customerId)}`, 'POST', body);
}

// ---- Products --------------------------------------------------------------

export interface CreateProductParams {
  name: string;
  description?: string;
  active?: boolean;
  metadata?: Record<string, string>;
  images?: string[];
  unit_label?: string;
  url?: string;
}

export async function createProduct(params: CreateProductParams): Promise<any> {
  const body: Record<string, unknown> = { name: params.name };
  if (params.description) body.description = params.description;
  if (params.active !== undefined) body.active = params.active;
  if (params.metadata) body.metadata = params.metadata;
  if (params.images?.length) body.images = params.images;
  if (params.unit_label) body.unit_label = params.unit_label;
  if (params.url) body.url = params.url;
  return stripeWrite('/v1/products', 'POST', body);
}

// ---- Prices ----------------------------------------------------------------

export interface CreatePriceParams {
  currency: string;          // ISO 4217 lowercase e.g. 'usd'
  product: string;           // existing product ID
  unit_amount?: number;      // in cents (for fixed pricing)
  recurring?: {
    interval: 'day' | 'week' | 'month' | 'year';
    interval_count?: number;
  };
  nickname?: string;
  metadata?: Record<string, string>;
}

export async function createPrice(params: CreatePriceParams): Promise<any> {
  const body: Record<string, unknown> = {
    currency: params.currency,
    product: params.product,
  };
  if (params.unit_amount !== undefined) body.unit_amount = params.unit_amount;
  if (params.recurring) body.recurring = params.recurring;
  if (params.nickname) body.nickname = params.nickname;
  if (params.metadata) body.metadata = params.metadata;
  return stripeWrite('/v1/prices', 'POST', body);
}

// ---- Payment Links ---------------------------------------------------------

export interface CreatePaymentLinkParams {
  line_items: Array<{ price: string; quantity: number }>;
  after_completion?: { type: 'hosted_confirmation' | 'redirect'; redirect?: { url: string } };
  allow_promotion_codes?: boolean;
  metadata?: Record<string, string>;
  phone_number_collection?: { enabled: boolean };
}

export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<any> {
  const body: Record<string, unknown> = {
    line_items: params.line_items,
  };
  if (params.after_completion) body.after_completion = params.after_completion;
  if (params.allow_promotion_codes !== undefined)
    body.allow_promotion_codes = params.allow_promotion_codes;
  if (params.metadata) body.metadata = params.metadata;
  if (params.phone_number_collection)
    body.phone_number_collection = params.phone_number_collection;
  return stripeWrite('/v1/payment_links', 'POST', body);
}

// ---- Subscriptions ---------------------------------------------------------

export interface CancelSubscriptionParams {
  subscriptionId: string;
  /** If true, cancel at end of current billing period. Default false (immediate). */
  cancel_at_period_end?: boolean;
  prorate?: boolean;
  invoice_now?: boolean;
}

export async function cancelSubscription(params: CancelSubscriptionParams): Promise<any> {
  if (params.cancel_at_period_end) {
    // Soft cancel: PATCH-style POST to update cancel_at_period_end=true
    const body: Record<string, unknown> = { cancel_at_period_end: true };
    if (params.prorate !== undefined) body.prorate = params.prorate;
    return stripeWrite(
      `/v1/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
      'POST',
      body,
    );
  }
  // Hard cancel: DELETE
  const body: Record<string, unknown> = {};
  if (params.prorate !== undefined) body.prorate = params.prorate;
  if (params.invoice_now !== undefined) body.invoice_now = params.invoice_now;
  return stripeWrite(
    `/v1/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
    'DELETE',
    Object.keys(body).length ? body : undefined,
  );
}

// ---- Invoices --------------------------------------------------------------

export interface CreateInvoiceParams {
  customer: string;
  collection_method?: 'charge_automatically' | 'send_invoice';
  days_until_due?: number;
  description?: string;
  auto_advance?: boolean;
  metadata?: Record<string, string>;
}

export async function createInvoice(params: CreateInvoiceParams): Promise<any> {
  const body: Record<string, unknown> = { customer: params.customer };
  if (params.collection_method) body.collection_method = params.collection_method;
  if (params.days_until_due !== undefined) body.days_until_due = params.days_until_due;
  if (params.description) body.description = params.description;
  if (params.auto_advance !== undefined) body.auto_advance = params.auto_advance;
  if (params.metadata) body.metadata = params.metadata;
  return stripeWrite('/v1/invoices', 'POST', body);
}
