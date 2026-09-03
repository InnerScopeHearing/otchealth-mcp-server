/**
 * Shopify Admin REST write client.
 *
 * Self-contained — mirrors auth/request pattern from client.ts (same base URL,
 * same X-Shopify-Access-Token header, same ShopifyApiError shape) but only
 * exposes mutating operations. Import from write-client.js in tool wrappers.
 *
 * API version: follows SHOPIFY_API_VERSION env var (default 2026-04).
 * All endpoints are REST (not GraphQL) to match the existing read client.
 */

import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class (mirrors ShopifyApiError in client.ts — kept separate so this
// file is truly self-contained, but the shape is identical).
// ---------------------------------------------------------------------------

export class ShopifyWriteError extends Error {
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
    this.name = 'ShopifyWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireConfigured(): { shop: string; version: string; token: string } {
  if (!env.SHOPIFY_ACCESS_TOKEN || !env.SHOPIFY_SHOP) {
    throw new ShopifyWriteError({
      code: 'shopify_not_configured',
      status: 0,
      message: 'Shopify integration is not configured.',
      nextStep:
        "Set SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN in Railway env vars. Values are in Matt's Notion Token Vault under Shopify section.",
    });
  }
  return {
    shop: env.SHOPIFY_SHOP,
    version: env.SHOPIFY_API_VERSION,
    token: env.SHOPIFY_ACCESS_TOKEN,
  };
}

function mapError(status: number, path: string, body: string): ShopifyWriteError {
  let upstream: unknown = body;
  try {
    upstream = JSON.parse(body);
  } catch {
    /* keep string */
  }
  if (status === 401 || status === 403) {
    return new ShopifyWriteError({
      code: 'shopify_auth_failed',
      status,
      message: `Shopify Admin API rejected auth on ${path}.`,
      nextStep:
        "Confirm SHOPIFY_ACCESS_TOKEN matches the value in Matt's Notion Token Vault (last rotated 2026-04-30). Rotate if leaked.",
      upstream,
    });
  }
  if (status === 404) {
    return new ShopifyWriteError({
      code: 'shopify_not_found',
      status,
      message: `Shopify Admin API returned 404 for ${path}.`,
      nextStep: `Verify the ID exists at https://${env.SHOPIFY_SHOP}/admin/.`,
      upstream,
    });
  }
  if (status === 422) {
    return new ShopifyWriteError({
      code: 'shopify_validation_error',
      status,
      message: `Shopify returned 422 (Unprocessable Entity) for ${path}.`,
      nextStep: 'Check the upstream field for Shopify validation errors and fix the request body.',
      upstream,
    });
  }
  if (status === 429) {
    return new ShopifyWriteError({
      code: 'shopify_rate_limited',
      status,
      message: 'Shopify Admin API rate-limited the call.',
      nextStep: 'Back off 2-5 seconds and retry. Shopify uses a leaky-bucket; sequential writes are safest.',
      upstream,
    });
  }
  if (status >= 500) {
    return new ShopifyWriteError({
      code: 'shopify_upstream_error',
      status,
      message: `Shopify returned ${status} for ${path}.`,
      nextStep: 'Shopify upstream error. Check https://www.shopifystatus.com/ and retry shortly.',
      upstream,
    });
  }
  return new ShopifyWriteError({
    code: 'shopify_request_error',
    status,
    message: `Shopify returned ${status} for ${path}.`,
    nextStep: 'Verify the input parameters match the Shopify Admin API documentation.',
    upstream,
  });
}

async function shopifyRestWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; correlationId?: string } = {},
): Promise<T> {
  const { shop, version, token } = requireConfigured();
  const url = `https://${shop}/admin/api/${version}${path}`;
  const started = Date.now();
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  try {
    // Every call through shopifyRestWrite() is a non-idempotent mutation (product/order/
    // draft-order/fulfillment/inventory write, some HIGH-RISK e.g. completeDraftOrder and
    // fulfillOrder trigger a real charge / shipment): retries:0 so a timeout never causes
    // a duplicate order, fulfillment, or inventory write.
    const res = await fetchWithBudget(url, {
      method,
      headers: {
        'x-shopify-access-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: bodyStr,
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries: 0 });
    const text = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        {
          type: 'shopify_write_ok',
          method,
          path,
          status: res.status,
          latency_ms: latency,
          correlation_id: opts.correlationId,
        },
        'shopify write ok',
      );
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    throw mapError(res.status, path, text);
  } catch (err) {
    if (err instanceof ShopifyWriteError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'shopify_write_network_error',
        method,
        path,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'shopify write network error',
    );
    throw new ShopifyWriteError({
      code: 'shopify_network_error',
      status: 0,
      message: `Network error calling Shopify Admin API at ${path}: ${(err as Error).message}`,
      nextStep:
        'Check Railway logs and Shopify status (https://www.shopifystatus.com/). Retry if transient.',
      upstream: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Product types
// ---------------------------------------------------------------------------

export interface ShopifyProductVariantInput {
  id?: number;
  price?: string;
  sku?: string;
  barcode?: string;
  inventory_management?: string | null;
  inventory_policy?: 'deny' | 'continue';
  taxable?: boolean;
  weight?: number;
  weight_unit?: 'g' | 'kg' | 'oz' | 'lb';
  requires_shipping?: boolean;
  option1?: string;
  option2?: string;
  option3?: string;
  compare_at_price?: string | null;
}

export interface ShopifyProductInput {
  title?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string;
  status?: 'active' | 'archived' | 'draft';
  variants?: ShopifyProductVariantInput[];
  options?: Array<{ name: string }>;
  images?: Array<{ src: string; alt?: string }>;
  handle?: string;
  published?: boolean;
}

// ---------------------------------------------------------------------------
// Inventory types
// ---------------------------------------------------------------------------

export interface UpdateInventoryLevelInput {
  location_id: number;
  inventory_item_id: number;
  available: number;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Draft order types
// ---------------------------------------------------------------------------

export interface ShopifyDraftOrderLineItem {
  variant_id?: number;
  product_id?: number;
  title?: string;
  price?: string;
  quantity: number;
  sku?: string;
  custom?: boolean;
  requires_shipping?: boolean;
  taxable?: boolean;
  properties?: Array<{ name: string; value: string }>;
  applied_discount?: {
    description?: string;
    value_type: 'fixed_amount' | 'percentage';
    value: string;
    title?: string;
  };
}

export interface ShopifyAddress {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
  company?: string;
}

export interface ShopifyDraftOrderInput {
  line_items: ShopifyDraftOrderLineItem[];
  customer?: { id?: number; email?: string };
  shipping_address?: ShopifyAddress;
  billing_address?: ShopifyAddress;
  note?: string;
  tags?: string;
  email?: string;
  use_customer_default_address?: boolean;
  shipping_line?: {
    custom: boolean;
    title: string;
    price: string;
    code?: string;
  };
  applied_discount?: {
    description?: string;
    value_type: 'fixed_amount' | 'percentage';
    value: string;
    title?: string;
  };
  tax_exempt?: boolean;
  send_receipt?: boolean;
}

// ---------------------------------------------------------------------------
// Discount / Price-rule types
// ---------------------------------------------------------------------------

export interface ShopifyPriceRuleInput {
  title: string;
  target_type: 'line_item' | 'shipping_line';
  target_selection: 'all' | 'entitled';
  allocation_method: 'across' | 'each';
  value_type: 'fixed_amount' | 'percentage';
  value: string; // negative number as string, e.g. "-10.0"
  customer_selection: 'all' | 'prerequisite';
  starts_at: string; // ISO 8601
  ends_at?: string;
  usage_limit?: number;
  once_per_customer?: boolean;
  prerequisite_subtotal_range?: { greater_than_or_equal_to: string };
}

export interface ShopifyDiscountCodeInput {
  code: string;
  usage_limit?: number | null;
  starts_at?: string;
  ends_at?: string;
}

// ---------------------------------------------------------------------------
// Fulfillment types
// ---------------------------------------------------------------------------

export interface ShopifyFulfillmentInput {
  location_id: number;
  tracking_number?: string;
  tracking_company?: string;
  tracking_url?: string;
  notify_customer?: boolean;
  line_items_by_fulfillment_order?: Array<{
    fulfillment_order_id: number;
    fulfillment_order_line_items?: Array<{ id: number; quantity: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Write functions (exported — called by tool wrappers)
// ---------------------------------------------------------------------------

/**
 * POST /products.json — create a new product.
 */
export async function createProduct(
  product: ShopifyProductInput,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyRestWrite<{ product?: unknown }>(
    'POST',
    '/products.json',
    { product },
    opts,
  );
  return data.product ?? data;
}

/**
 * PUT /products/{id}.json — update an existing product.
 */
export async function updateProduct(
  productId: number | string,
  product: ShopifyProductInput,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(productId));
  const data = await shopifyRestWrite<{ product?: unknown }>(
    'PUT',
    `/products/${id}.json`,
    { product },
    opts,
  );
  return data.product ?? data;
}

/**
 * POST /inventory_levels/set.json — set the available inventory count for an
 * inventory item at a specific location.
 */
export async function updateInventoryLevel(
  input: UpdateInventoryLevelInput,
): Promise<unknown> {
  const { correlationId, ...body } = input;
  const data = await shopifyRestWrite<{ inventory_level?: unknown }>(
    'POST',
    '/inventory_levels/set.json',
    body,
    { correlationId },
  );
  return data.inventory_level ?? data;
}

/**
 * POST /draft_orders.json — create a draft order.
 */
export async function createDraftOrder(
  draftOrder: ShopifyDraftOrderInput,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyRestWrite<{ draft_order?: unknown }>(
    'POST',
    '/draft_orders.json',
    { draft_order: draftOrder },
    opts,
  );
  return data.draft_order ?? data;
}

/**
 * POST /draft_orders/{id}/complete.json — complete a draft order, converting
 * it to a real order and (optionally) capturing payment.
 * HIGH-RISK: creates a real order / charge.
 */
export async function completeDraftOrder(
  draftOrderId: number | string,
  paymentPending: boolean = false,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(draftOrderId));
  const data = await shopifyRestWrite<{ draft_order?: unknown }>(
    'PUT',
    `/draft_orders/${id}/complete.json?payment_pending=${paymentPending}`,
    undefined,
    opts,
  );
  return data.draft_order ?? data;
}

/**
 * POST /price_rules.json — create a price rule (the parent of discount codes).
 * Returns { price_rule, discount_code } — the initial discount code is created
 * by a follow-up call to createDiscountCode; we do that automatically here.
 *
 * Returns { price_rule, discount_code }.
 */
export async function createPriceRuleWithCode(
  priceRule: ShopifyPriceRuleInput,
  discountCode: ShopifyDiscountCodeInput,
  opts: { correlationId?: string } = {},
): Promise<{ price_rule: unknown; discount_code: unknown }> {
  const prData = await shopifyRestWrite<{ price_rule?: unknown }>(
    'POST',
    '/price_rules.json',
    { price_rule: priceRule },
    opts,
  );
  const createdRule = prData.price_rule as { id?: number } | undefined;
  if (!createdRule?.id) {
    throw new ShopifyWriteError({
      code: 'shopify_price_rule_create_failed',
      status: 0,
      message: 'Price rule was created but returned no ID.',
      nextStep: 'Check Shopify Admin > Discounts manually.',
      upstream: prData,
    });
  }
  const dcData = await shopifyRestWrite<{ discount_code?: unknown }>(
    'POST',
    `/price_rules/${createdRule.id}/discount_codes.json`,
    { discount_code: discountCode },
    opts,
  );
  return {
    price_rule: createdRule,
    discount_code: dcData.discount_code ?? dcData,
  };
}

/**
 * POST /orders/{id}/fulfillments.json — create a fulfillment for an order
 * using the fulfillment order model (2022-01+).
 * HIGH-RISK: triggers shipping + customer notification.
 */
export async function fulfillOrder(
  orderId: number | string,
  fulfillment: ShopifyFulfillmentInput,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  // Shopify 2022-01+ prefers POST /fulfillments.json (global endpoint) to support
  // the fulfillment order model. We use the order-scoped endpoint for simplicity
  // and backward compat with all API versions.
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyRestWrite<{ fulfillment?: unknown }>(
    'POST',
    `/orders/${id}/fulfillments.json`,
    { fulfillment },
    opts,
  );
  return data.fulfillment ?? data;
}

/**
 * PUT /orders/{id}.json — update an order's tags, note, or email.
 * Only the fields that an operator is safe to patch (tags, note, email).
 */
export async function updateOrder(
  orderId: number | string,
  patch: { tags?: string; note?: string; email?: string },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyRestWrite<{ order?: unknown }>(
    'PUT',
    `/orders/${id}.json`,
    { order: patch },
    opts,
  );
  return data.order ?? data;
}
