/**
 * Gumroad FULL client — NEW file, self-contained.
 * Covers the complete Gumroad API v2 surface not already in api-client.ts or write-client.ts.
 * Auth mirrors api-client.ts exactly: access_token as query param for GETs,
 * in form body for POST/PUT/DELETE.
 *
 * NOT SUPPORTED by Gumroad API v2 (confirmed absent):
 *   - POST /v2/products (create product) — dashboard only
 *   - GET /v2/products/:id/variant_categories/:id (get single variant category)
 *   - Product reviews endpoint — no public API
 *   - Payout initiation (list/get payouts is read-only; no trigger payout endpoint)
 *   - Subscription plan changes (only cancel via subscriber endpoint)
 *   - Bulk operations of any kind
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();
const BASE = 'https://api.gumroad.com/v2';

// ---- Error class (mirrors GumroadApiError) ----

export class GumroadFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GumroadFullError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.GUMROAD_ACCESS_TOKEN) {
    throw new GumroadFullError({
      code: 'gumroad_not_configured',
      status: 0,
      message: 'GUMROAD_ACCESS_TOKEN is not set.',
      nextStep: 'Add GUMROAD_ACCESS_TOKEN to the MCP server environment (Settings > Advanced > Applications in Gumroad).',
    });
  }
  return env.GUMROAD_ACCESS_TOKEN;
}

// GET helper — access_token in query string
async function gGet<T = any>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const key = requireKey();
  const params = new URLSearchParams();
  params.set('access_token', key);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const url = `${BASE}${path}?${params.toString()}`;
  const { statusCode, body: respBody } = await request(url, { method: 'GET' });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400 || data?.success === false) {
    throw new GumroadFullError({
      code: `gumroad_${statusCode}`,
      status: statusCode,
      message: data?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Verify GUMROAD_ACCESS_TOKEN has correct scopes (Settings > Advanced > Applications).',
      upstream: data,
    });
  }
  return data as T;
}

// Mutate helper — access_token + fields in form body
async function gMutate<T = any>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  fields?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const key = requireKey();
  const params = new URLSearchParams();
  params.set('access_token', key);
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const url = `${BASE}${path}`;
  const { statusCode, body: respBody } = await request(url, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400 || data?.success === false) {
    throw new GumroadFullError({
      code: `gumroad_${statusCode}`,
      status: statusCode,
      message: data?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Verify GUMROAD_ACCESS_TOKEN is valid and has write scopes (Settings > Advanced > Applications).',
      upstream: data,
    });
  }
  return data as T;
}

// ===========================================================================
// USER
// ===========================================================================

export async function getUser(): Promise<any> {
  return gGet('/user');
}

// ===========================================================================
// PRODUCTS
// ===========================================================================

export async function getProduct(productId: string): Promise<any> {
  return gGet(`/products/${productId}`);
}

export async function deleteProduct(productId: string): Promise<any> {
  return gMutate('DELETE', `/products/${productId}`);
}

// ===========================================================================
// VARIANT CATEGORIES
// ===========================================================================

export async function listVariantCategories(productId: string): Promise<any> {
  return gGet(`/products/${productId}/variant_categories`);
}

export async function createVariantCategory(productId: string, title: string): Promise<any> {
  return gMutate('POST', `/products/${productId}/variant_categories`, { title });
}

export async function updateVariantCategory(productId: string, categoryId: string, title: string): Promise<any> {
  return gMutate('PUT', `/products/${productId}/variant_categories/${categoryId}`, { title });
}

export async function deleteVariantCategory(productId: string, categoryId: string): Promise<any> {
  return gMutate('DELETE', `/products/${productId}/variant_categories/${categoryId}`);
}

// ===========================================================================
// VARIANTS
// ===========================================================================

export async function listVariants(productId: string, categoryId: string): Promise<any> {
  return gGet(`/products/${productId}/variant_categories/${categoryId}/variants`);
}

export interface CreateVariantOpts {
  name: string;
  price_difference_cents?: number;
  max_purchase_count?: number;
}

export async function createVariant(productId: string, categoryId: string, opts: CreateVariantOpts): Promise<any> {
  return gMutate('POST', `/products/${productId}/variant_categories/${categoryId}/variants`, {
    name: opts.name,
    price_difference_cents: opts.price_difference_cents,
    max_purchase_count: opts.max_purchase_count,
  });
}

export interface UpdateVariantOpts {
  name?: string;
  price_difference_cents?: number;
  max_purchase_count?: number;
}

export async function updateVariant(productId: string, categoryId: string, variantId: string, opts: UpdateVariantOpts): Promise<any> {
  return gMutate('PUT', `/products/${productId}/variant_categories/${categoryId}/variants/${variantId}`, {
    name: opts.name,
    price_difference_cents: opts.price_difference_cents,
    max_purchase_count: opts.max_purchase_count,
  });
}

export async function deleteVariant(productId: string, categoryId: string, variantId: string): Promise<any> {
  return gMutate('DELETE', `/products/${productId}/variant_categories/${categoryId}/variants/${variantId}`);
}

// ===========================================================================
// OFFER CODES
// ===========================================================================

export async function listOfferCodes(productId: string): Promise<any> {
  return gGet(`/products/${productId}/offer_codes`);
}

export async function getOfferCode(productId: string, offerCodeId: string): Promise<any> {
  return gGet(`/products/${productId}/offer_codes/${offerCodeId}`);
}

export interface CreateOfferCodeOpts {
  name: string;
  amount_off: number;
  offer_type?: 'cents' | 'percent';
  max_purchase_count?: number;
  universal?: boolean;
}

export async function createOfferCode(productId: string, opts: CreateOfferCodeOpts): Promise<any> {
  return gMutate('POST', `/products/${productId}/offer_codes`, {
    name: opts.name,
    amount_off: opts.amount_off,
    offer_type: opts.offer_type,
    max_purchase_count: opts.max_purchase_count,
    universal: opts.universal,
  });
}

export interface UpdateOfferCodeOpts {
  max_purchase_count?: number;
}

export async function updateOfferCode(productId: string, offerCodeId: string, opts: UpdateOfferCodeOpts): Promise<any> {
  return gMutate('PUT', `/products/${productId}/offer_codes/${offerCodeId}`, {
    max_purchase_count: opts.max_purchase_count,
  });
}

export async function deleteOfferCode(productId: string, offerCodeId: string): Promise<any> {
  return gMutate('DELETE', `/products/${productId}/offer_codes/${offerCodeId}`);
}

// ===========================================================================
// CUSTOM FIELDS
// ===========================================================================

export async function listCustomFields(productId: string): Promise<any> {
  return gGet(`/products/${productId}/custom_fields`);
}

export interface CreateCustomFieldOpts {
  name: string;
  required?: boolean;
}

export async function createCustomField(productId: string, opts: CreateCustomFieldOpts): Promise<any> {
  return gMutate('POST', `/products/${productId}/custom_fields`, {
    name: opts.name,
    required: opts.required,
  });
}

export interface UpdateCustomFieldOpts {
  name?: string;
  required?: boolean;
}

/** Note: Gumroad uses the field name (not an ID) as the URL param for custom field PUT/DELETE. */
export async function updateCustomField(productId: string, fieldName: string, opts: UpdateCustomFieldOpts): Promise<any> {
  return gMutate('PUT', `/products/${productId}/custom_fields/${encodeURIComponent(fieldName)}`, {
    name: opts.name,
    required: opts.required,
  });
}

export async function deleteCustomField(productId: string, fieldName: string): Promise<any> {
  return gMutate('DELETE', `/products/${productId}/custom_fields/${encodeURIComponent(fieldName)}`);
}

// ===========================================================================
// SALES
// ===========================================================================

export async function getSale(saleId: string): Promise<any> {
  return gGet(`/sales/${saleId}`);
}

export async function markSaleAsShipped(saleId: string, trackingUrl?: string): Promise<any> {
  return gMutate('PUT', `/sales/${saleId}/mark_as_shipped`, {
    tracking_url: trackingUrl,
  });
}

export async function refundSale(saleId: string, amountCents?: number): Promise<any> {
  return gMutate('PUT', `/sales/${saleId}/refund`, {
    amount_cents: amountCents,
  });
}

export async function resendSaleReceipt(saleId: string): Promise<any> {
  return gMutate('POST', `/sales/${saleId}/resend_receipt`);
}

// ===========================================================================
// SUBSCRIBERS
// ===========================================================================

export async function listSubscribers(productId: string, email?: string): Promise<any> {
  return gGet(`/products/${productId}/subscribers`, { email });
}

export async function getSubscriber(subscriberId: string): Promise<any> {
  return gGet(`/subscribers/${subscriberId}`);
}

// ===========================================================================
// RESOURCE SUBSCRIPTIONS (WEBHOOKS)
// ===========================================================================

/** resource_name values: sale | refund | dispute | dispute_won | cancellation |
 *  subscription_updated | subscription_ended | subscription_restarted */
export async function listResourceSubscriptions(resourceName?: string): Promise<any> {
  return gGet('/resource_subscriptions', { resource_name: resourceName });
}

export async function createResourceSubscription(resourceName: string, postUrl: string): Promise<any> {
  return gMutate('PUT', '/resource_subscriptions', {
    resource_name: resourceName,
    post_url: postUrl,
  });
}

export async function deleteResourceSubscription(resourceSubscriptionId: string): Promise<any> {
  return gMutate('DELETE', `/resource_subscriptions/${resourceSubscriptionId}`);
}

// ===========================================================================
// LICENSES
// ===========================================================================

export interface LicenseParams {
  product_id: string;
  license_key: string;
}

export async function verifyLicense(params: LicenseParams & { increment_uses_count?: boolean }): Promise<any> {
  return gMutate('POST', '/licenses/verify', {
    product_id: params.product_id,
    license_key: params.license_key,
    increment_uses_count: params.increment_uses_count,
  });
}

export async function enableLicense(params: LicenseParams): Promise<any> {
  return gMutate('PUT', '/licenses/enable', {
    product_id: params.product_id,
    license_key: params.license_key,
  });
}

export async function disableLicense(params: LicenseParams): Promise<any> {
  return gMutate('PUT', '/licenses/disable', {
    product_id: params.product_id,
    license_key: params.license_key,
  });
}

export async function rotateLicense(params: LicenseParams): Promise<any> {
  return gMutate('PUT', '/licenses/rotate', {
    product_id: params.product_id,
    license_key: params.license_key,
  });
}

export async function decrementLicenseUsesCount(params: LicenseParams): Promise<any> {
  return gMutate('PUT', '/licenses/decrement_uses_count', {
    product_id: params.product_id,
    license_key: params.license_key,
  });
}
