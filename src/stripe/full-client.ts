/**
 * Stripe full-surface API client.
 *
 * Self-contained: owns its own auth + form-encoded request helpers.
 * Auth: Basic auth with STRIPE_SECRET_KEY (same pattern as api-client.ts / write-client.ts).
 * POST bodies: application/x-www-form-urlencoded with bracket-notation nesting.
 *
 * NEVER import from api-client.ts or write-client.ts — this file is intentionally
 * standalone so the full surface can be audited and gated independently.
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class StripeFullClientError extends Error {
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
    this.name = 'StripeFullClientError';
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
    throw new StripeFullClientError({
      code: 'stripe_not_configured',
      status: 0,
      message: 'STRIPE_SECRET_KEY is not set.',
      nextStep: 'Add STRIPE_SECRET_KEY to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.STRIPE_SECRET_KEY;
}

const BASE = 'https://api.stripe.com';

/**
 * Flatten a nested object into Stripe's bracket-notation form params.
 * e.g. { metadata: { key: 'val' } } -> "metadata[key]=val"
 * e.g. { items: [{ price: 'price_xxx' }] } -> "items[0][price]=price_xxx"
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

async function stripeGet<T = unknown>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const key = requireKey();
  let url = `${BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
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
      'Stripe-Version': '2024-06-20',
    },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) {
    throw new StripeFullClientError({
      code: `stripe_${data?.error?.type ?? statusCode}`,
      status: statusCode,
      message: data?.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check Stripe API error details. Ensure STRIPE_SECRET_KEY is valid.',
      upstream: data?.error,
    });
  }
  return data as T;
}

async function stripePost<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const key = requireKey();
  const url = `${BASE}${path}`;
  const auth = Buffer.from(`${key}:`).toString('base64');
  const params = body ? flattenParams(body) : new URLSearchParams();
  const bodyStr = params.toString();
  // Non-idempotent financial mutation (subscriptions, invoices, payment intents, payouts,
  // etc.), no idempotency key wired: retries:0 so a timeout never doubles a Stripe write.
  const res = await fetchWithBudget(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: bodyStr || undefined,
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) {
    throw new StripeFullClientError({
      code: `stripe_${data?.error?.type ?? statusCode}`,
      status: statusCode,
      message: data?.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check Stripe API error details. Ensure STRIPE_SECRET_KEY is valid and has write permissions.',
      upstream: data?.error,
    });
  }
  return data as T;
}

async function stripeDelete<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const key = requireKey();
  const url = `${BASE}${path}`;
  const auth = Buffer.from(`${key}:`).toString('base64');
  const params = body ? flattenParams(body) : new URLSearchParams();
  const bodyStr = params.toString();
  // Non-idempotent delete (product/customer/coupon/invoice-draft deletion): retries:0
  // so a timeout never causes a duplicate delete attempt against a since-deleted resource.
  const res = await fetchWithBudget(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: bodyStr || undefined,
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) {
    throw new StripeFullClientError({
      code: `stripe_${data?.error?.type ?? statusCode}`,
      status: statusCode,
      message: data?.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check Stripe API error details. Ensure STRIPE_SECRET_KEY is valid and has write permissions.',
      upstream: data?.error,
    });
  }
  return data as T;
}

// ===========================================================================
// SUBSCRIPTIONS
// ===========================================================================

export async function getSubscription(subscriptionId: string): Promise<any> {
  return stripeGet(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function listSubscriptions(opts?: {
  limit?: number;
  customer?: string;
  status?: string;
  price?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/subscriptions', {
    limit: opts?.limit,
    customer: opts?.customer,
    status: opts?.status,
    price: opts?.price,
    starting_after: opts?.starting_after,
  });
}

export async function updateSubscription(
  subscriptionId: string,
  params: {
    cancel_at_period_end?: boolean;
    proration_behavior?: string;
    items?: Array<{ id?: string; price?: string; quantity?: number; deleted?: boolean }>;
    metadata?: Record<string, string>;
    description?: string;
    payment_behavior?: string;
    billing_cycle_anchor?: string;
    coupon?: string;
    promotion_code?: string;
    trial_end?: string | number;
    cancel_at?: number;
    default_payment_method?: string;
  },
): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.cancel_at_period_end !== undefined) body.cancel_at_period_end = params.cancel_at_period_end;
  if (params.proration_behavior) body.proration_behavior = params.proration_behavior;
  if (params.items) body.items = params.items;
  if (params.metadata) body.metadata = params.metadata;
  if (params.description) body.description = params.description;
  if (params.payment_behavior) body.payment_behavior = params.payment_behavior;
  if (params.billing_cycle_anchor) body.billing_cycle_anchor = params.billing_cycle_anchor;
  if (params.coupon) body.coupon = params.coupon;
  if (params.promotion_code) body.promotion_code = params.promotion_code;
  if (params.trial_end !== undefined) body.trial_end = params.trial_end;
  if (params.cancel_at !== undefined) body.cancel_at = params.cancel_at;
  if (params.default_payment_method) body.default_payment_method = params.default_payment_method;
  return stripePost(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, body);
}

export async function createSubscription(params: {
  customer: string;
  items: Array<{ price: string; quantity?: number }>;
  trial_period_days?: number;
  trial_end?: number;
  cancel_at_period_end?: boolean;
  collection_method?: string;
  coupon?: string;
  promotion_code?: string;
  default_payment_method?: string;
  payment_behavior?: string;
  metadata?: Record<string, string>;
  description?: string;
  proration_behavior?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {
    customer: params.customer,
    items: params.items,
  };
  if (params.trial_period_days !== undefined) body.trial_period_days = params.trial_period_days;
  if (params.trial_end !== undefined) body.trial_end = params.trial_end;
  if (params.cancel_at_period_end !== undefined) body.cancel_at_period_end = params.cancel_at_period_end;
  if (params.collection_method) body.collection_method = params.collection_method;
  if (params.coupon) body.coupon = params.coupon;
  if (params.promotion_code) body.promotion_code = params.promotion_code;
  if (params.default_payment_method) body.default_payment_method = params.default_payment_method;
  if (params.payment_behavior) body.payment_behavior = params.payment_behavior;
  if (params.metadata) body.metadata = params.metadata;
  if (params.description) body.description = params.description;
  if (params.proration_behavior) body.proration_behavior = params.proration_behavior;
  return stripePost('/v1/subscriptions', body);
}

// Subscription Items

export async function listSubscriptionItems(subscriptionId: string, opts?: {
  limit?: number;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/subscription_items', {
    subscription: subscriptionId,
    limit: opts?.limit,
    starting_after: opts?.starting_after,
  });
}

export async function updateSubscriptionItem(
  itemId: string,
  params: {
    price?: string;
    quantity?: number;
    metadata?: Record<string, string>;
    proration_behavior?: string;
    payment_behavior?: string;
  },
): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.price) body.price = params.price;
  if (params.quantity !== undefined) body.quantity = params.quantity;
  if (params.metadata) body.metadata = params.metadata;
  if (params.proration_behavior) body.proration_behavior = params.proration_behavior;
  if (params.payment_behavior) body.payment_behavior = params.payment_behavior;
  return stripePost(`/v1/subscription_items/${encodeURIComponent(itemId)}`, body);
}

// ===========================================================================
// INVOICES
// ===========================================================================

export async function getInvoice(invoiceId: string): Promise<any> {
  return stripeGet(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
}

export async function listInvoices(opts?: {
  limit?: number;
  customer?: string;
  status?: string;
  subscription?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/invoices', {
    limit: opts?.limit,
    customer: opts?.customer,
    status: opts?.status,
    subscription: opts?.subscription,
    starting_after: opts?.starting_after,
  });
}

export async function updateInvoice(
  invoiceId: string,
  params: {
    description?: string;
    metadata?: Record<string, string>;
    footer?: string;
    auto_advance?: boolean;
    collection_method?: string;
    days_until_due?: number;
    due_date?: number;
  },
): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.description) body.description = params.description;
  if (params.metadata) body.metadata = params.metadata;
  if (params.footer) body.footer = params.footer;
  if (params.auto_advance !== undefined) body.auto_advance = params.auto_advance;
  if (params.collection_method) body.collection_method = params.collection_method;
  if (params.days_until_due !== undefined) body.days_until_due = params.days_until_due;
  if (params.due_date !== undefined) body.due_date = params.due_date;
  return stripePost(`/v1/invoices/${encodeURIComponent(invoiceId)}`, body);
}

export async function finalizeInvoice(invoiceId: string, autoAdvance?: boolean): Promise<any> {
  const body: Record<string, unknown> = {};
  if (autoAdvance !== undefined) body.auto_advance = autoAdvance;
  return stripePost(`/v1/invoices/${encodeURIComponent(invoiceId)}/finalize`, body);
}

export async function voidInvoice(invoiceId: string): Promise<any> {
  return stripePost(`/v1/invoices/${encodeURIComponent(invoiceId)}/void`);
}

export async function payInvoice(invoiceId: string, params?: {
  payment_method?: string;
  source?: string;
  forgive?: boolean;
  mandate?: string;
  off_session?: boolean;
  paid_out_of_band?: boolean;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params?.payment_method) body.payment_method = params.payment_method;
  if (params?.source) body.source = params.source;
  if (params?.forgive !== undefined) body.forgive = params.forgive;
  if (params?.mandate) body.mandate = params.mandate;
  if (params?.off_session !== undefined) body.off_session = params.off_session;
  if (params?.paid_out_of_band !== undefined) body.paid_out_of_band = params.paid_out_of_band;
  return stripePost(`/v1/invoices/${encodeURIComponent(invoiceId)}/pay`, body);
}

export async function sendInvoice(invoiceId: string): Promise<any> {
  return stripePost(`/v1/invoices/${encodeURIComponent(invoiceId)}/send`);
}

export async function deleteInvoiceDraft(invoiceId: string): Promise<any> {
  return stripeDelete(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
}

// Invoice Items

export async function createInvoiceItem(params: {
  customer: string;
  amount?: number;
  currency?: string;
  description?: string;
  invoice?: string;
  price?: string;
  quantity?: number;
  metadata?: Record<string, string>;
}): Promise<any> {
  const body: Record<string, unknown> = { customer: params.customer };
  if (params.amount !== undefined) body.amount = params.amount;
  if (params.currency) body.currency = params.currency;
  if (params.description) body.description = params.description;
  if (params.invoice) body.invoice = params.invoice;
  if (params.price) body.price = params.price;
  if (params.quantity !== undefined) body.quantity = params.quantity;
  if (params.metadata) body.metadata = params.metadata;
  return stripePost('/v1/invoiceitems', body);
}

export async function deleteInvoiceItem(invoiceItemId: string): Promise<any> {
  return stripeDelete(`/v1/invoiceitems/${encodeURIComponent(invoiceItemId)}`);
}

// ===========================================================================
// PAYMENT INTENTS
// ===========================================================================

export async function getPaymentIntent(paymentIntentId: string): Promise<any> {
  return stripeGet(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`);
}

export async function createPaymentIntent(params: {
  amount: number;
  currency: string;
  customer?: string;
  payment_method?: string;
  description?: string;
  confirm?: boolean;
  return_url?: string;
  automatic_payment_methods?: { enabled: boolean };
  metadata?: Record<string, string>;
  receipt_email?: string;
  statement_descriptor?: string;
  capture_method?: string;
  setup_future_usage?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {
    amount: params.amount,
    currency: params.currency,
  };
  if (params.customer) body.customer = params.customer;
  if (params.payment_method) body.payment_method = params.payment_method;
  if (params.description) body.description = params.description;
  if (params.confirm !== undefined) body.confirm = params.confirm;
  if (params.return_url) body.return_url = params.return_url;
  if (params.automatic_payment_methods) body.automatic_payment_methods = params.automatic_payment_methods;
  if (params.metadata) body.metadata = params.metadata;
  if (params.receipt_email) body.receipt_email = params.receipt_email;
  if (params.statement_descriptor) body.statement_descriptor = params.statement_descriptor;
  if (params.capture_method) body.capture_method = params.capture_method;
  if (params.setup_future_usage) body.setup_future_usage = params.setup_future_usage;
  return stripePost('/v1/payment_intents', body);
}

export async function confirmPaymentIntent(paymentIntentId: string, params?: {
  payment_method?: string;
  return_url?: string;
  mandate?: string;
  off_session?: boolean;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params?.payment_method) body.payment_method = params.payment_method;
  if (params?.return_url) body.return_url = params.return_url;
  if (params?.mandate) body.mandate = params.mandate;
  if (params?.off_session !== undefined) body.off_session = params.off_session;
  return stripePost(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/confirm`, body);
}

export async function capturePaymentIntent(paymentIntentId: string, params?: {
  amount_to_capture?: number;
  statement_descriptor?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params?.amount_to_capture !== undefined) body.amount_to_capture = params.amount_to_capture;
  if (params?.statement_descriptor) body.statement_descriptor = params.statement_descriptor;
  return stripePost(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, body);
}

export async function cancelPaymentIntent(paymentIntentId: string, cancellation_reason?: string): Promise<any> {
  const body: Record<string, unknown> = {};
  if (cancellation_reason) body.cancellation_reason = cancellation_reason;
  return stripePost(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, body);
}

// ===========================================================================
// CHARGES
// ===========================================================================

export async function getCharge(chargeId: string): Promise<any> {
  return stripeGet(`/v1/charges/${encodeURIComponent(chargeId)}`);
}

export async function captureCharge(chargeId: string, params?: {
  amount?: number;
  receipt_email?: string;
  statement_descriptor?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params?.amount !== undefined) body.amount = params.amount;
  if (params?.receipt_email) body.receipt_email = params.receipt_email;
  if (params?.statement_descriptor) body.statement_descriptor = params.statement_descriptor;
  return stripePost(`/v1/charges/${encodeURIComponent(chargeId)}/capture`, body);
}

// ===========================================================================
// REFUNDS
// ===========================================================================

export async function listRefunds(opts?: {
  limit?: number;
  charge?: string;
  payment_intent?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/refunds', {
    limit: opts?.limit,
    charge: opts?.charge,
    payment_intent: opts?.payment_intent,
    starting_after: opts?.starting_after,
  });
}

export async function getRefund(refundId: string): Promise<any> {
  return stripeGet(`/v1/refunds/${encodeURIComponent(refundId)}`);
}

export async function updateRefund(refundId: string, metadata: Record<string, string>): Promise<any> {
  return stripePost(`/v1/refunds/${encodeURIComponent(refundId)}`, { metadata });
}

// ===========================================================================
// PAYOUTS
// ===========================================================================

export async function listPayouts(opts?: {
  limit?: number;
  status?: string;
  starting_after?: string;
  arrival_date_gte?: number;
  arrival_date_lte?: number;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/payouts', {
    limit: opts?.limit,
    status: opts?.status,
    starting_after: opts?.starting_after,
    'arrival_date[gte]': opts?.arrival_date_gte,
    'arrival_date[lte]': opts?.arrival_date_lte,
  });
}

export async function getPayout(payoutId: string): Promise<any> {
  return stripeGet(`/v1/payouts/${encodeURIComponent(payoutId)}`);
}

export async function createPayout(params: {
  amount: number;
  currency: string;
  description?: string;
  destination?: string;
  method?: 'instant' | 'standard';
  metadata?: Record<string, string>;
  statement_descriptor?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {
    amount: params.amount,
    currency: params.currency,
  };
  if (params.description) body.description = params.description;
  if (params.destination) body.destination = params.destination;
  if (params.method) body.method = params.method;
  if (params.metadata) body.metadata = params.metadata;
  if (params.statement_descriptor) body.statement_descriptor = params.statement_descriptor;
  return stripePost('/v1/payouts', body);
}

export async function cancelPayout(payoutId: string): Promise<any> {
  return stripePost(`/v1/payouts/${encodeURIComponent(payoutId)}/cancel`);
}

// ===========================================================================
// BALANCE TRANSACTIONS
// ===========================================================================

export async function listBalanceTransactions(opts?: {
  limit?: number;
  type?: string;
  payout?: string;
  source?: string;
  starting_after?: string;
  created_gte?: number;
  created_lte?: number;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/balance_transactions', {
    limit: opts?.limit,
    type: opts?.type,
    payout: opts?.payout,
    source: opts?.source,
    starting_after: opts?.starting_after,
    'created[gte]': opts?.created_gte,
    'created[lte]': opts?.created_lte,
  });
}

export async function getBalanceTransaction(txnId: string): Promise<any> {
  return stripeGet(`/v1/balance_transactions/${encodeURIComponent(txnId)}`);
}

// ===========================================================================
// DISPUTES
// ===========================================================================

export async function listDisputes(opts?: {
  limit?: number;
  charge?: string;
  payment_intent?: string;
  status?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/disputes', {
    limit: opts?.limit,
    charge: opts?.charge,
    payment_intent: opts?.payment_intent,
    status: opts?.status,
    starting_after: opts?.starting_after,
  });
}

export async function getDispute(disputeId: string): Promise<any> {
  return stripeGet(`/v1/disputes/${encodeURIComponent(disputeId)}`);
}

export async function updateDispute(
  disputeId: string,
  params: {
    evidence?: Record<string, string>;
    metadata?: Record<string, string>;
    submit?: boolean;
  },
): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.evidence) body.evidence = params.evidence;
  if (params.metadata) body.metadata = params.metadata;
  if (params.submit !== undefined) body.submit = params.submit;
  return stripePost(`/v1/disputes/${encodeURIComponent(disputeId)}`, body);
}

export async function closeDispute(disputeId: string): Promise<any> {
  return stripePost(`/v1/disputes/${encodeURIComponent(disputeId)}/close`);
}

// ===========================================================================
// COUPONS
// ===========================================================================

export async function listCoupons(opts?: {
  limit?: number;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/coupons', {
    limit: opts?.limit,
    starting_after: opts?.starting_after,
  });
}

export async function getCoupon(couponId: string): Promise<any> {
  return stripeGet(`/v1/coupons/${encodeURIComponent(couponId)}`);
}

export async function createCoupon(params: {
  amount_off?: number;
  percent_off?: number;
  currency?: string;
  duration: 'forever' | 'once' | 'repeating';
  duration_in_months?: number;
  id?: string;
  max_redemptions?: number;
  name?: string;
  redeem_by?: number;
  applies_to?: { products: string[] };
  metadata?: Record<string, string>;
}): Promise<any> {
  const body: Record<string, unknown> = { duration: params.duration };
  if (params.amount_off !== undefined) body.amount_off = params.amount_off;
  if (params.percent_off !== undefined) body.percent_off = params.percent_off;
  if (params.currency) body.currency = params.currency;
  if (params.duration_in_months !== undefined) body.duration_in_months = params.duration_in_months;
  if (params.id) body.id = params.id;
  if (params.max_redemptions !== undefined) body.max_redemptions = params.max_redemptions;
  if (params.name) body.name = params.name;
  if (params.redeem_by !== undefined) body.redeem_by = params.redeem_by;
  if (params.applies_to) body.applies_to = params.applies_to;
  if (params.metadata) body.metadata = params.metadata;
  return stripePost('/v1/coupons', body);
}

export async function updateCoupon(couponId: string, params: {
  metadata?: Record<string, string>;
  name?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.metadata) body.metadata = params.metadata;
  if (params.name) body.name = params.name;
  return stripePost(`/v1/coupons/${encodeURIComponent(couponId)}`, body);
}

export async function deleteCoupon(couponId: string): Promise<any> {
  return stripeDelete(`/v1/coupons/${encodeURIComponent(couponId)}`);
}

// ===========================================================================
// PROMOTION CODES
// ===========================================================================

export async function listPromotionCodes(opts?: {
  limit?: number;
  code?: string;
  active?: boolean;
  coupon?: string;
  customer?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/promotion_codes', {
    limit: opts?.limit,
    code: opts?.code,
    active: opts?.active,
    coupon: opts?.coupon,
    customer: opts?.customer,
    starting_after: opts?.starting_after,
  });
}

export async function getPromotionCode(promotionCodeId: string): Promise<any> {
  return stripeGet(`/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`);
}

export async function createPromotionCode(params: {
  coupon: string;
  code?: string;
  active?: boolean;
  customer?: string;
  expires_at?: number;
  max_redemptions?: number;
  metadata?: Record<string, string>;
  restrictions?: {
    first_time_transaction?: boolean;
    minimum_amount?: number;
    minimum_amount_currency?: string;
  };
}): Promise<any> {
  const body: Record<string, unknown> = { coupon: params.coupon };
  if (params.code) body.code = params.code;
  if (params.active !== undefined) body.active = params.active;
  if (params.customer) body.customer = params.customer;
  if (params.expires_at !== undefined) body.expires_at = params.expires_at;
  if (params.max_redemptions !== undefined) body.max_redemptions = params.max_redemptions;
  if (params.metadata) body.metadata = params.metadata;
  if (params.restrictions) body.restrictions = params.restrictions;
  return stripePost('/v1/promotion_codes', body);
}

export async function updatePromotionCode(promotionCodeId: string, params: {
  active?: boolean;
  metadata?: Record<string, string>;
  restrictions?: {
    first_time_transaction?: boolean;
    minimum_amount?: number;
    minimum_amount_currency?: string;
  };
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.active !== undefined) body.active = params.active;
  if (params.metadata) body.metadata = params.metadata;
  if (params.restrictions) body.restrictions = params.restrictions;
  return stripePost(`/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`, body);
}

// ===========================================================================
// CHECKOUT SESSIONS
// ===========================================================================

export async function listCheckoutSessions(opts?: {
  limit?: number;
  customer?: string;
  payment_intent?: string;
  subscription?: string;
  status?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/checkout/sessions', {
    limit: opts?.limit,
    customer: opts?.customer,
    payment_intent: opts?.payment_intent,
    subscription: opts?.subscription,
    status: opts?.status,
    starting_after: opts?.starting_after,
  });
}

export async function getCheckoutSession(sessionId: string): Promise<any> {
  return stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

export async function createCheckoutSession(params: {
  mode: 'payment' | 'subscription' | 'setup';
  success_url: string;
  cancel_url?: string;
  line_items?: Array<{ price: string; quantity: number }>;
  customer?: string;
  customer_email?: string;
  currency?: string;
  payment_method_types?: string[];
  metadata?: Record<string, string>;
  allow_promotion_codes?: boolean;
  automatic_tax?: { enabled: boolean };
  billing_address_collection?: string;
  locale?: string;
  client_reference_id?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {
    mode: params.mode,
    success_url: params.success_url,
  };
  if (params.cancel_url) body.cancel_url = params.cancel_url;
  if (params.line_items) body.line_items = params.line_items;
  if (params.customer) body.customer = params.customer;
  if (params.customer_email) body.customer_email = params.customer_email;
  if (params.currency) body.currency = params.currency;
  if (params.payment_method_types) body.payment_method_types = params.payment_method_types;
  if (params.metadata) body.metadata = params.metadata;
  if (params.allow_promotion_codes !== undefined) body.allow_promotion_codes = params.allow_promotion_codes;
  if (params.automatic_tax) body.automatic_tax = params.automatic_tax;
  if (params.billing_address_collection) body.billing_address_collection = params.billing_address_collection;
  if (params.locale) body.locale = params.locale;
  if (params.client_reference_id) body.client_reference_id = params.client_reference_id;
  return stripePost('/v1/checkout/sessions', body);
}

export async function expireCheckoutSession(sessionId: string): Promise<any> {
  return stripePost(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
}

// ===========================================================================
// SETUP INTENTS
// ===========================================================================

export async function listSetupIntents(opts?: {
  limit?: number;
  customer?: string;
  payment_method?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/setup_intents', {
    limit: opts?.limit,
    customer: opts?.customer,
    payment_method: opts?.payment_method,
    starting_after: opts?.starting_after,
  });
}

export async function getSetupIntent(setupIntentId: string): Promise<any> {
  return stripeGet(`/v1/setup_intents/${encodeURIComponent(setupIntentId)}`);
}

export async function createSetupIntent(params: {
  customer?: string;
  payment_method?: string;
  payment_method_types?: string[];
  usage?: 'off_session' | 'on_session';
  description?: string;
  metadata?: Record<string, string>;
  return_url?: string;
  automatic_payment_methods?: { enabled: boolean };
  confirm?: boolean;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.customer) body.customer = params.customer;
  if (params.payment_method) body.payment_method = params.payment_method;
  if (params.payment_method_types) body.payment_method_types = params.payment_method_types;
  if (params.usage) body.usage = params.usage;
  if (params.description) body.description = params.description;
  if (params.metadata) body.metadata = params.metadata;
  if (params.return_url) body.return_url = params.return_url;
  if (params.automatic_payment_methods) body.automatic_payment_methods = params.automatic_payment_methods;
  if (params.confirm !== undefined) body.confirm = params.confirm;
  return stripePost('/v1/setup_intents', body);
}

export async function cancelSetupIntent(setupIntentId: string, cancellation_reason?: string): Promise<any> {
  const body: Record<string, unknown> = {};
  if (cancellation_reason) body.cancellation_reason = cancellation_reason;
  return stripePost(`/v1/setup_intents/${encodeURIComponent(setupIntentId)}/cancel`, body);
}

// ===========================================================================
// PAYMENT METHODS
// ===========================================================================

export async function listPaymentMethods(opts: {
  customer?: string;
  type?: string;
  limit?: number;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/payment_methods', {
    customer: opts.customer,
    type: opts.type,
    limit: opts.limit,
    starting_after: opts.starting_after,
  });
}

export async function getPaymentMethod(paymentMethodId: string): Promise<any> {
  return stripeGet(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
}

export async function attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<any> {
  return stripePost(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`, {
    customer: customerId,
  });
}

export async function detachPaymentMethod(paymentMethodId: string): Promise<any> {
  return stripePost(`/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`);
}

// ===========================================================================
// PRICES
// ===========================================================================

export async function listPrices(opts?: {
  limit?: number;
  product?: string;
  active?: boolean;
  currency?: string;
  type?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/prices', {
    limit: opts?.limit,
    product: opts?.product,
    active: opts?.active,
    currency: opts?.currency,
    type: opts?.type,
    starting_after: opts?.starting_after,
  });
}

export async function getPrice(priceId: string): Promise<any> {
  return stripeGet(`/v1/prices/${encodeURIComponent(priceId)}`);
}

export async function updatePrice(priceId: string, params: {
  active?: boolean;
  nickname?: string;
  metadata?: Record<string, string>;
  lookup_key?: string;
  transfer_lookup_key?: boolean;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.active !== undefined) body.active = params.active;
  if (params.nickname) body.nickname = params.nickname;
  if (params.metadata) body.metadata = params.metadata;
  if (params.lookup_key) body.lookup_key = params.lookup_key;
  if (params.transfer_lookup_key !== undefined) body.transfer_lookup_key = params.transfer_lookup_key;
  return stripePost(`/v1/prices/${encodeURIComponent(priceId)}`, body);
}

// ===========================================================================
// PRODUCTS
// ===========================================================================

export async function getProduct(productId: string): Promise<any> {
  return stripeGet(`/v1/products/${encodeURIComponent(productId)}`);
}

export async function updateProduct(productId: string, params: {
  name?: string;
  description?: string;
  active?: boolean;
  metadata?: Record<string, string>;
  images?: string[];
  unit_label?: string;
  url?: string;
  statement_descriptor?: string;
  tax_code?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.description) body.description = params.description;
  if (params.active !== undefined) body.active = params.active;
  if (params.metadata) body.metadata = params.metadata;
  if (params.images) body.images = params.images;
  if (params.unit_label) body.unit_label = params.unit_label;
  if (params.url) body.url = params.url;
  if (params.statement_descriptor) body.statement_descriptor = params.statement_descriptor;
  if (params.tax_code) body.tax_code = params.tax_code;
  return stripePost(`/v1/products/${encodeURIComponent(productId)}`, body);
}

export async function deleteProduct(productId: string): Promise<any> {
  return stripeDelete(`/v1/products/${encodeURIComponent(productId)}`);
}

// ===========================================================================
// CUSTOMERS — supplemental
// ===========================================================================

export async function getCustomer(customerId: string): Promise<any> {
  return stripeGet(`/v1/customers/${encodeURIComponent(customerId)}`);
}

export async function deleteCustomer(customerId: string): Promise<any> {
  return stripeDelete(`/v1/customers/${encodeURIComponent(customerId)}`);
}

export async function listCustomerPaymentMethods(customerId: string, opts?: {
  type?: string;
  limit?: number;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet(`/v1/customers/${encodeURIComponent(customerId)}/payment_methods`, {
    type: opts?.type,
    limit: opts?.limit,
  });
}

// ===========================================================================
// CREDIT NOTES
// ===========================================================================

export async function listCreditNotes(opts?: {
  limit?: number;
  invoice?: string;
  customer?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/credit_notes', {
    limit: opts?.limit,
    invoice: opts?.invoice,
    customer: opts?.customer,
    starting_after: opts?.starting_after,
  });
}

export async function getCreditNote(creditNoteId: string): Promise<any> {
  return stripeGet(`/v1/credit_notes/${encodeURIComponent(creditNoteId)}`);
}

export async function createCreditNote(params: {
  invoice: string;
  amount?: number;
  credit_amount?: number;
  out_of_band_amount?: number;
  refund_amount?: number;
  reason?: string;
  lines?: Array<{ type: string; amount?: number; description?: string; invoice_line_item?: string }>;
  memo?: string;
  metadata?: Record<string, string>;
}): Promise<any> {
  const body: Record<string, unknown> = { invoice: params.invoice };
  if (params.amount !== undefined) body.amount = params.amount;
  if (params.credit_amount !== undefined) body.credit_amount = params.credit_amount;
  if (params.out_of_band_amount !== undefined) body.out_of_band_amount = params.out_of_band_amount;
  if (params.refund_amount !== undefined) body.refund_amount = params.refund_amount;
  if (params.reason) body.reason = params.reason;
  if (params.lines) body.lines = params.lines;
  if (params.memo) body.memo = params.memo;
  if (params.metadata) body.metadata = params.metadata;
  return stripePost('/v1/credit_notes', body);
}

export async function voidCreditNote(creditNoteId: string): Promise<any> {
  return stripePost(`/v1/credit_notes/${encodeURIComponent(creditNoteId)}/void`);
}

// ===========================================================================
// TAX RATES
// ===========================================================================

export async function listTaxRates(opts?: {
  limit?: number;
  active?: boolean;
  inclusive?: boolean;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/tax_rates', {
    limit: opts?.limit,
    active: opts?.active,
    inclusive: opts?.inclusive,
    starting_after: opts?.starting_after,
  });
}

export async function getTaxRate(taxRateId: string): Promise<any> {
  return stripeGet(`/v1/tax_rates/${encodeURIComponent(taxRateId)}`);
}

export async function createTaxRate(params: {
  display_name: string;
  percentage: number;
  inclusive: boolean;
  active?: boolean;
  country?: string;
  description?: string;
  jurisdiction?: string;
  metadata?: Record<string, string>;
  state?: string;
  tax_type?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {
    display_name: params.display_name,
    percentage: params.percentage,
    inclusive: params.inclusive,
  };
  if (params.active !== undefined) body.active = params.active;
  if (params.country) body.country = params.country;
  if (params.description) body.description = params.description;
  if (params.jurisdiction) body.jurisdiction = params.jurisdiction;
  if (params.metadata) body.metadata = params.metadata;
  if (params.state) body.state = params.state;
  if (params.tax_type) body.tax_type = params.tax_type;
  return stripePost('/v1/tax_rates', body);
}

export async function updateTaxRate(taxRateId: string, params: {
  active?: boolean;
  display_name?: string;
  description?: string;
  jurisdiction?: string;
  metadata?: Record<string, string>;
  tax_type?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.active !== undefined) body.active = params.active;
  if (params.display_name) body.display_name = params.display_name;
  if (params.description) body.description = params.description;
  if (params.jurisdiction) body.jurisdiction = params.jurisdiction;
  if (params.metadata) body.metadata = params.metadata;
  if (params.tax_type) body.tax_type = params.tax_type;
  return stripePost(`/v1/tax_rates/${encodeURIComponent(taxRateId)}`, body);
}

// ===========================================================================
// EVENTS
// ===========================================================================

export async function listEvents(opts?: {
  limit?: number;
  type?: string;
  starting_after?: string;
  created_gte?: number;
  created_lte?: number;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/events', {
    limit: opts?.limit,
    type: opts?.type,
    starting_after: opts?.starting_after,
    'created[gte]': opts?.created_gte,
    'created[lte]': opts?.created_lte,
  });
}

export async function getEvent(eventId: string): Promise<any> {
  return stripeGet(`/v1/events/${encodeURIComponent(eventId)}`);
}

// ===========================================================================
// SUBSCRIPTION SCHEDULES
// ===========================================================================

export async function listSubscriptionSchedules(opts?: {
  limit?: number;
  customer?: string;
  scheduled_plan?: string;
  starting_after?: string;
}): Promise<{ data: any[]; has_more: boolean }> {
  return stripeGet('/v1/subscription_schedules', {
    limit: opts?.limit,
    customer: opts?.customer,
    starting_after: opts?.starting_after,
  });
}

export async function getSubscriptionSchedule(scheduleId: string): Promise<any> {
  return stripeGet(`/v1/subscription_schedules/${encodeURIComponent(scheduleId)}`);
}

export async function createSubscriptionSchedule(params: {
  customer?: string;
  from_subscription?: string;
  start_date?: number | 'now';
  phases?: Array<{
    items: Array<{ price: string; quantity?: number }>;
    iterations?: number;
    coupon?: string;
    trial?: boolean;
    trial_end?: number;
  }>;
  end_behavior?: 'cancel' | 'release' | 'none';
  metadata?: Record<string, string>;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.customer) body.customer = params.customer;
  if (params.from_subscription) body.from_subscription = params.from_subscription;
  if (params.start_date !== undefined) body.start_date = params.start_date;
  if (params.phases) body.phases = params.phases;
  if (params.end_behavior) body.end_behavior = params.end_behavior;
  if (params.metadata) body.metadata = params.metadata;
  return stripePost('/v1/subscription_schedules', body);
}

export async function cancelSubscriptionSchedule(scheduleId: string, invoice_now?: boolean, prorate?: boolean): Promise<any> {
  const body: Record<string, unknown> = {};
  if (invoice_now !== undefined) body.invoice_now = invoice_now;
  if (prorate !== undefined) body.prorate = prorate;
  return stripePost(`/v1/subscription_schedules/${encodeURIComponent(scheduleId)}/cancel`, body);
}

export async function releaseSubscriptionSchedule(scheduleId: string, preserve_cancel_date?: boolean): Promise<any> {
  const body: Record<string, unknown> = {};
  if (preserve_cancel_date !== undefined) body.preserve_cancel_date = preserve_cancel_date;
  return stripePost(`/v1/subscription_schedules/${encodeURIComponent(scheduleId)}/release`, body);
}

export async function updateSubscriptionSchedule(scheduleId: string, params: {
  end_behavior?: 'cancel' | 'release' | 'none';
  phases?: Array<{
    items: Array<{ price: string; quantity?: number }>;
    iterations?: number;
    start_date?: number;
    end_date?: number;
    coupon?: string;
    trial?: boolean;
    trial_end?: number;
  }>;
  metadata?: Record<string, string>;
  proration_behavior?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (params.end_behavior) body.end_behavior = params.end_behavior;
  if (params.phases) body.phases = params.phases;
  if (params.metadata) body.metadata = params.metadata;
  if (params.proration_behavior) body.proration_behavior = params.proration_behavior;
  return stripePost(`/v1/subscription_schedules/${encodeURIComponent(scheduleId)}`, body);
}
