/**
 * Shopify Admin REST — FULL surface client.
 *
 * Self-contained: copies auth + request pattern from client.ts / write-client.ts.
 * Same base URL, same X-Shopify-Access-Token header, same error shape.
 * API version: follows SHOPIFY_API_VERSION env var (default 2024-10).
 *
 * Exports one async function per operation. Import from full-client.js in tool wrappers.
 */

import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class (identical shape to ShopifyApiError / ShopifyWriteError)
// ---------------------------------------------------------------------------

export class ShopifyFullClientError extends Error {
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
    this.name = 'ShopifyFullClientError';
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
    throw new ShopifyFullClientError({
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

function buildQuery(q?: Record<string, string | number | boolean | undefined | null>): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function mapError(status: number, path: string, body: string): ShopifyFullClientError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep string */ }
  if (status === 401 || status === 403) {
    return new ShopifyFullClientError({
      code: 'shopify_auth_failed',
      status,
      message: `Shopify Admin API rejected auth on ${path}.`,
      nextStep:
        "Confirm SHOPIFY_ACCESS_TOKEN matches the value in Matt's Notion Token Vault (last rotated 2026-04-30). Rotate if leaked.",
      upstream,
    });
  }
  if (status === 404) {
    return new ShopifyFullClientError({
      code: 'shopify_not_found',
      status,
      message: `Shopify Admin API returned 404 for ${path}.`,
      nextStep: `Verify the ID exists at https://${env.SHOPIFY_SHOP}/admin/.`,
      upstream,
    });
  }
  if (status === 422) {
    return new ShopifyFullClientError({
      code: 'shopify_validation_error',
      status,
      message: `Shopify returned 422 (Unprocessable Entity) for ${path}.`,
      nextStep: 'Check the upstream field for Shopify validation errors and fix the request body.',
      upstream,
    });
  }
  if (status === 429) {
    return new ShopifyFullClientError({
      code: 'shopify_rate_limited',
      status,
      message: 'Shopify Admin API rate-limited the call.',
      nextStep: 'Back off 2-5 seconds and retry. Shopify uses a leaky-bucket; sequential calls are safest.',
      upstream,
    });
  }
  if (status >= 500) {
    return new ShopifyFullClientError({
      code: 'shopify_upstream_error',
      status,
      message: `Shopify returned ${status} for ${path}.`,
      nextStep: 'Shopify upstream error. Check https://www.shopifystatus.com/ and retry shortly.',
      upstream,
    });
  }
  return new ShopifyFullClientError({
    code: 'shopify_request_error',
    status,
    message: `Shopify returned ${status} for ${path}.`,
    nextStep: 'Verify the input parameters match the Shopify Admin API documentation.',
    upstream,
  });
}

async function shopifyGet<T = unknown>(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
  opts: { timeoutMs?: number; correlationId?: string } = {},
): Promise<T> {
  const { shop, version, token } = requireConfigured();
  const url = `https://${shop}/admin/api/${version}${path}${buildQuery(query)}`;
  const started = Date.now();
  try {
    // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
    const res = await fetchWithBudget(url, {
      method: 'GET',
      headers: {
        'x-shopify-access-token': token,
        accept: 'application/json',
      },
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries: 1 });
    const body = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug({ type: 'shopify_full_get_ok', path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId }, 'shopify full get ok');
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.status, path, body);
  } catch (err) {
    if (err instanceof ShopifyFullClientError) throw err;
    const latency = Date.now() - started;
    logger.error({ type: 'shopify_full_get_network_error', path, latency_ms: latency, correlation_id: opts.correlationId, err: (err as Error).message }, 'shopify full get network error');
    throw new ShopifyFullClientError({
      code: 'shopify_network_error',
      status: 0,
      message: `Network error calling Shopify Admin API at ${path}: ${(err as Error).message}`,
      nextStep: 'Check Railway logs and Shopify status (https://www.shopifystatus.com/). Retry if transient.',
      upstream: err,
    });
  }
}

async function shopifyWrite<T = unknown>(
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
    // Non-idempotent mutation across the full order/product/customer/discount surface:
    // retries:0 so a timeout never causes a duplicate Shopify write.
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
      logger.debug({ type: 'shopify_full_write_ok', method, path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId }, 'shopify full write ok');
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    throw mapError(res.status, path, text);
  } catch (err) {
    if (err instanceof ShopifyFullClientError) throw err;
    const latency = Date.now() - started;
    logger.error({ type: 'shopify_full_write_network_error', method, path, latency_ms: latency, correlation_id: opts.correlationId, err: (err as Error).message }, 'shopify full write network error');
    throw new ShopifyFullClientError({
      code: 'shopify_network_error',
      status: 0,
      message: `Network error calling Shopify Admin API at ${path}: ${(err as Error).message}`,
      nextStep: 'Check Railway logs and Shopify status (https://www.shopifystatus.com/). Retry if transient.',
      upstream: err,
    });
  }
}

// ============================================================================
// ORDERS
// ============================================================================

export async function listOrders(
  params: {
    limit?: number;
    page_info?: string;
    status?: string;
    financial_status?: string;
    fulfillment_status?: string;
    created_at_min?: string;
    created_at_max?: string;
    updated_at_min?: string;
    updated_at_max?: string;
    fields?: string;
    ids?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ orders?: unknown[] }>('/orders.json', params as Record<string, string | number | undefined>, opts);
  return data.orders ?? data;
}

export async function countOrders(
  params: { status?: string; financial_status?: string; fulfillment_status?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  return shopifyGet<{ count?: number }>('/orders/count.json', params as Record<string, string | undefined>, opts);
}

export async function closeOrder(
  orderId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyWrite<{ order?: unknown }>('POST', `/orders/${id}/close.json`, undefined, opts);
  return data.order ?? data;
}

export async function reopenOrder(
  orderId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyWrite<{ order?: unknown }>('POST', `/orders/${id}/open.json`, undefined, opts);
  return data.order ?? data;
}

export async function cancelOrder(
  orderId: number | string,
  params: {
    amount?: string;
    currency?: string;
    restock?: boolean;
    reason?: string;
    email?: boolean;
    refund?: unknown;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyWrite<{ order?: unknown }>('POST', `/orders/${id}/cancel.json`, params, opts);
  return data.order ?? data;
}

export async function deleteOrder(
  orderId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  return shopifyWrite<unknown>('DELETE', `/orders/${id}.json`, undefined, opts);
}

// ============================================================================
// CUSTOMERS
// ============================================================================

export async function listCustomers(
  params: {
    limit?: number;
    page_info?: string;
    ids?: string;
    created_at_min?: string;
    created_at_max?: string;
    updated_at_min?: string;
    updated_at_max?: string;
    fields?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ customers?: unknown[] }>('/customers.json', params as Record<string, string | number | undefined>, opts);
  return data.customers ?? data;
}

export async function getCustomer(
  customerId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(customerId));
  const data = await shopifyGet<{ customer?: unknown }>(`/customers/${id}.json`, undefined, opts);
  return data.customer ?? data;
}

export async function createCustomer(
  customer: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    note?: string;
    tags?: string;
    verified_email?: boolean;
    accepts_marketing?: boolean;
    addresses?: unknown[];
    metafields?: unknown[];
    send_email_welcome?: boolean;
    password?: string;
    password_confirmation?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ customer?: unknown }>('POST', '/customers.json', { customer }, opts);
  return data.customer ?? data;
}

export async function updateCustomer(
  customerId: number | string,
  customer: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    note?: string;
    tags?: string;
    accepts_marketing?: boolean;
    metafields?: unknown[];
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(customerId));
  const data = await shopifyWrite<{ customer?: unknown }>('PUT', `/customers/${id}.json`, { customer }, opts);
  return data.customer ?? data;
}

export async function deleteCustomer(
  customerId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(customerId));
  return shopifyWrite<unknown>('DELETE', `/customers/${id}.json`, undefined, opts);
}

export async function searchCustomers(
  query: string,
  params: { limit?: number; fields?: string; order?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ customers?: unknown[] }>('/customers/search.json', { query, ...params } as Record<string, string | number | undefined>, opts);
  return data.customers ?? data;
}

// ============================================================================
// PRODUCTS — delete only (list/get/create/update already exist)
// ============================================================================

export async function deleteProduct(
  productId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(productId));
  return shopifyWrite<unknown>('DELETE', `/products/${id}.json`, undefined, opts);
}

// ============================================================================
// PRODUCT VARIANTS
// ============================================================================

export async function listProductVariants(
  productId: number | string,
  params: { limit?: number; page_info?: string; fields?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(productId));
  const data = await shopifyGet<{ variants?: unknown[] }>(`/products/${id}/variants.json`, params as Record<string, string | number | undefined>, opts);
  return data.variants ?? data;
}

export async function getProductVariant(
  variantId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(variantId));
  const data = await shopifyGet<{ variant?: unknown }>(`/variants/${id}.json`, undefined, opts);
  return data.variant ?? data;
}

export async function createProductVariant(
  productId: number | string,
  variant: {
    option1?: string;
    option2?: string;
    option3?: string;
    price?: string;
    sku?: string;
    barcode?: string;
    inventory_management?: string;
    inventory_policy?: string;
    taxable?: boolean;
    weight?: number;
    weight_unit?: string;
    requires_shipping?: boolean;
    compare_at_price?: string | null;
    image_id?: number;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(productId));
  const data = await shopifyWrite<{ variant?: unknown }>('POST', `/products/${id}/variants.json`, { variant }, opts);
  return data.variant ?? data;
}

export async function updateProductVariant(
  variantId: number | string,
  variant: {
    option1?: string;
    option2?: string;
    option3?: string;
    price?: string;
    sku?: string;
    barcode?: string;
    inventory_management?: string;
    inventory_policy?: string;
    taxable?: boolean;
    weight?: number;
    weight_unit?: string;
    requires_shipping?: boolean;
    compare_at_price?: string | null;
    image_id?: number;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(variantId));
  const data = await shopifyWrite<{ variant?: unknown }>('PUT', `/variants/${id}.json`, { variant }, opts);
  return data.variant ?? data;
}

export async function deleteProductVariant(
  productId: number | string,
  variantId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const pid = encodeURIComponent(String(productId));
  const vid = encodeURIComponent(String(variantId));
  return shopifyWrite<unknown>('DELETE', `/products/${pid}/variants/${vid}.json`, undefined, opts);
}

// ============================================================================
// COLLECTIONS (collects — abstract list of products in a collection)
// ============================================================================

export async function listCollections(
  params: { limit?: number; page_info?: string; product_id?: string | number } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ collects?: unknown[] }>('/collects.json', params as Record<string, string | number | undefined>, opts);
  return data.collects ?? data;
}

export async function addProductToCollection(
  productId: number | string,
  collectionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ collect?: unknown }>('POST', '/collects.json', { collect: { product_id: productId, collection_id: collectionId } }, opts);
  return data.collect ?? data;
}

export async function removeProductFromCollection(
  collectId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectId));
  return shopifyWrite<unknown>('DELETE', `/collects/${id}.json`, undefined, opts);
}

// ============================================================================
// CUSTOM COLLECTIONS
// ============================================================================

export async function listCustomCollections(
  params: {
    limit?: number;
    page_info?: string;
    title?: string;
    product_id?: string | number;
    published_status?: string;
    fields?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ custom_collections?: unknown[] }>('/custom_collections.json', params as Record<string, string | number | undefined>, opts);
  return data.custom_collections ?? data;
}

export async function getCustomCollection(
  collectionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  const data = await shopifyGet<{ custom_collection?: unknown }>(`/custom_collections/${id}.json`, undefined, opts);
  return data.custom_collection ?? data;
}

export async function createCustomCollection(
  collection: {
    title: string;
    body_html?: string;
    image?: { src: string; alt?: string };
    sort_order?: string;
    published?: boolean;
    handle?: string;
    template_suffix?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ custom_collection?: unknown }>('POST', '/custom_collections.json', { custom_collection: collection }, opts);
  return data.custom_collection ?? data;
}

export async function updateCustomCollection(
  collectionId: number | string,
  collection: {
    title?: string;
    body_html?: string;
    image?: { src: string; alt?: string };
    sort_order?: string;
    published?: boolean;
    handle?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  const data = await shopifyWrite<{ custom_collection?: unknown }>('PUT', `/custom_collections/${id}.json`, { custom_collection: collection }, opts);
  return data.custom_collection ?? data;
}

export async function deleteCustomCollection(
  collectionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  return shopifyWrite<unknown>('DELETE', `/custom_collections/${id}.json`, undefined, opts);
}

// ============================================================================
// SMART COLLECTIONS
// ============================================================================

export async function listSmartCollections(
  params: {
    limit?: number;
    page_info?: string;
    title?: string;
    product_id?: string | number;
    published_status?: string;
    fields?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ smart_collections?: unknown[] }>('/smart_collections.json', params as Record<string, string | number | undefined>, opts);
  return data.smart_collections ?? data;
}

export async function getSmartCollection(
  collectionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  const data = await shopifyGet<{ smart_collection?: unknown }>(`/smart_collections/${id}.json`, undefined, opts);
  return data.smart_collection ?? data;
}

export async function createSmartCollection(
  collection: {
    title: string;
    rules?: Array<{ column: string; relation: string; condition: string }>;
    disjunctive?: boolean;
    body_html?: string;
    sort_order?: string;
    published?: boolean;
    handle?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ smart_collection?: unknown }>('POST', '/smart_collections.json', { smart_collection: collection }, opts);
  return data.smart_collection ?? data;
}

export async function updateSmartCollection(
  collectionId: number | string,
  collection: {
    title?: string;
    rules?: Array<{ column: string; relation: string; condition: string }>;
    disjunctive?: boolean;
    body_html?: string;
    sort_order?: string;
    published?: boolean;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  const data = await shopifyWrite<{ smart_collection?: unknown }>('PUT', `/smart_collections/${id}.json`, { smart_collection: collection }, opts);
  return data.smart_collection ?? data;
}

export async function deleteSmartCollection(
  collectionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(collectionId));
  return shopifyWrite<unknown>('DELETE', `/smart_collections/${id}.json`, undefined, opts);
}

// ============================================================================
// INVENTORY LEVELS
// ============================================================================

export async function listInventoryLevels(
  params: {
    inventory_item_ids?: string;
    location_ids?: string;
    limit?: number;
    updated_at_min?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ inventory_levels?: unknown[] }>('/inventory_levels.json', params as Record<string, string | number | undefined>, opts);
  return data.inventory_levels ?? data;
}

export async function connectInventoryLevel(
  locationId: number | string,
  inventoryItemId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ inventory_level?: unknown }>(
    'POST',
    '/inventory_levels/connect.json',
    { location_id: locationId, inventory_item_id: inventoryItemId },
    opts,
  );
  return data.inventory_level ?? data;
}

export async function adjustInventoryLevel(
  locationId: number | string,
  inventoryItemId: number | string,
  availableAdjustment: number,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ inventory_level?: unknown }>(
    'POST',
    '/inventory_levels/adjust.json',
    { location_id: locationId, inventory_item_id: inventoryItemId, available_adjustment: availableAdjustment },
    opts,
  );
  return data.inventory_level ?? data;
}

// ============================================================================
// INVENTORY ITEMS
// ============================================================================

export async function getInventoryItem(
  inventoryItemId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(inventoryItemId));
  const data = await shopifyGet<{ inventory_item?: unknown }>(`/inventory_items/${id}.json`, undefined, opts);
  return data.inventory_item ?? data;
}

export async function updateInventoryItem(
  inventoryItemId: number | string,
  item: {
    sku?: string;
    tracked?: boolean;
    cost?: string;
    country_code_of_origin?: string;
    province_code_of_origin?: string;
    harmonized_system_code?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(inventoryItemId));
  const data = await shopifyWrite<{ inventory_item?: unknown }>('PUT', `/inventory_items/${id}.json`, { inventory_item: item }, opts);
  return data.inventory_item ?? data;
}

// ============================================================================
// DRAFT ORDERS — list/get/update/delete/send_invoice (create/complete already exist)
// ============================================================================

export async function listDraftOrders(
  params: {
    limit?: number;
    page_info?: string;
    status?: string;
    ids?: string;
    fields?: string;
    updated_at_min?: string;
    updated_at_max?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ draft_orders?: unknown[] }>('/draft_orders.json', params as Record<string, string | number | undefined>, opts);
  return data.draft_orders ?? data;
}

export async function getDraftOrder(
  draftOrderId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(draftOrderId));
  const data = await shopifyGet<{ draft_order?: unknown }>(`/draft_orders/${id}.json`, undefined, opts);
  return data.draft_order ?? data;
}

export async function updateDraftOrder(
  draftOrderId: number | string,
  patch: {
    note?: string;
    tags?: string;
    email?: string;
    line_items?: unknown[];
    shipping_address?: unknown;
    billing_address?: unknown;
    shipping_line?: unknown;
    applied_discount?: unknown;
    tax_exempt?: boolean;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(draftOrderId));
  const data = await shopifyWrite<{ draft_order?: unknown }>('PUT', `/draft_orders/${id}.json`, { draft_order: patch }, opts);
  return data.draft_order ?? data;
}

export async function deleteDraftOrder(
  draftOrderId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(draftOrderId));
  return shopifyWrite<unknown>('DELETE', `/draft_orders/${id}.json`, undefined, opts);
}

export async function sendDraftOrderInvoice(
  draftOrderId: number | string,
  invoice: {
    to?: string;
    from?: string;
    bcc?: string[];
    subject?: string;
    custom_message?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(draftOrderId));
  const data = await shopifyWrite<{ draft_order_invoice?: unknown }>('POST', `/draft_orders/${id}/send_invoice.json`, { draft_order_invoice: invoice }, opts);
  return data.draft_order_invoice ?? data;
}

// ============================================================================
// FULFILLMENTS — list/get/update/cancel (create already exists as fulfill-order)
// ============================================================================

export async function listFulfillments(
  orderId: number | string,
  params: { limit?: number; fields?: string; created_at_min?: string; created_at_max?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyGet<{ fulfillments?: unknown[] }>(`/orders/${id}/fulfillments.json`, params as Record<string, string | number | undefined>, opts);
  return data.fulfillments ?? data;
}

export async function getFulfillment(
  orderId: number | string,
  fulfillmentId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const oid = encodeURIComponent(String(orderId));
  const fid = encodeURIComponent(String(fulfillmentId));
  const data = await shopifyGet<{ fulfillment?: unknown }>(`/orders/${oid}/fulfillments/${fid}.json`, undefined, opts);
  return data.fulfillment ?? data;
}

export async function updateFulfillment(
  orderId: number | string,
  fulfillmentId: number | string,
  patch: { tracking_number?: string; tracking_company?: string; tracking_url?: string; notify_customer?: boolean },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const oid = encodeURIComponent(String(orderId));
  const fid = encodeURIComponent(String(fulfillmentId));
  const data = await shopifyWrite<{ fulfillment?: unknown }>('PUT', `/orders/${oid}/fulfillments/${fid}.json`, { fulfillment: patch }, opts);
  return data.fulfillment ?? data;
}

export async function cancelFulfillment(
  orderId: number | string,
  fulfillmentId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const oid = encodeURIComponent(String(orderId));
  const fid = encodeURIComponent(String(fulfillmentId));
  const data = await shopifyWrite<{ fulfillment?: unknown }>('POST', `/orders/${oid}/fulfillments/${fid}/cancel.json`, undefined, opts);
  return data.fulfillment ?? data;
}

// ============================================================================
// REFUNDS
// ============================================================================

export async function calculateRefund(
  orderId: number | string,
  params: {
    shipping?: { full_refund?: boolean; amount?: string };
    refund_line_items?: Array<{ line_item_id: number; quantity: number; restock_type?: string }>;
    currency?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyWrite<{ refund?: unknown }>('POST', `/orders/${id}/refunds/calculate.json`, { refund: params }, opts);
  return data.refund ?? data;
}

export async function createRefund(
  orderId: number | string,
  refund: {
    currency?: string;
    notify?: boolean;
    note?: string;
    shipping?: { full_refund?: boolean; amount?: string };
    refund_line_items?: Array<{ line_item_id: number; quantity: number; restock_type?: string; location_id?: number }>;
    transactions?: Array<{ parent_id: number; amount: string; kind: string; gateway?: string }>;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyWrite<{ refund?: unknown }>('POST', `/orders/${id}/refunds.json`, { refund }, opts);
  return data.refund ?? data;
}

export async function listRefunds(
  orderId: number | string,
  params: { limit?: number; fields?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyGet<{ refunds?: unknown[] }>(`/orders/${id}/refunds.json`, params as Record<string, string | number | undefined>, opts);
  return data.refunds ?? data;
}

// ============================================================================
// TRANSACTIONS
// ============================================================================

export async function listTransactions(
  orderId: number | string,
  params: { limit?: number; fields?: string; since_id?: number } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(orderId));
  const data = await shopifyGet<{ transactions?: unknown[] }>(`/orders/${id}/transactions.json`, params as Record<string, string | number | undefined>, opts);
  return data.transactions ?? data;
}

export async function getTransaction(
  orderId: number | string,
  transactionId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const oid = encodeURIComponent(String(orderId));
  const tid = encodeURIComponent(String(transactionId));
  const data = await shopifyGet<{ transaction?: unknown }>(`/orders/${oid}/transactions/${tid}.json`, undefined, opts);
  return data.transaction ?? data;
}

// ============================================================================
// PRICE RULES — list/get/update/delete (create already exists via write-client)
// ============================================================================

export async function listPriceRules(
  params: {
    limit?: number;
    page_info?: string;
    starts_at_min?: string;
    starts_at_max?: string;
    ends_at_min?: string;
    ends_at_max?: string;
    created_at_min?: string;
    created_at_max?: string;
    updated_at_min?: string;
    updated_at_max?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ price_rules?: unknown[] }>('/price_rules.json', params as Record<string, string | undefined>, opts);
  return data.price_rules ?? data;
}

export async function getPriceRule(
  priceRuleId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(priceRuleId));
  const data = await shopifyGet<{ price_rule?: unknown }>(`/price_rules/${id}.json`, undefined, opts);
  return data.price_rule ?? data;
}

export async function updatePriceRule(
  priceRuleId: number | string,
  patch: {
    title?: string;
    value?: string;
    starts_at?: string;
    ends_at?: string | null;
    usage_limit?: number | null;
    once_per_customer?: boolean;
    customer_selection?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(priceRuleId));
  const data = await shopifyWrite<{ price_rule?: unknown }>('PUT', `/price_rules/${id}.json`, { price_rule: patch }, opts);
  return data.price_rule ?? data;
}

export async function deletePriceRule(
  priceRuleId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(priceRuleId));
  return shopifyWrite<unknown>('DELETE', `/price_rules/${id}.json`, undefined, opts);
}

// ============================================================================
// DISCOUNT CODES — list/get/update/delete (create already exists via write-client)
// ============================================================================

export async function listDiscountCodes(
  priceRuleId: number | string,
  params: { limit?: number; page_info?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(priceRuleId));
  const data = await shopifyGet<{ discount_codes?: unknown[] }>(`/price_rules/${id}/discount_codes.json`, params as Record<string, string | number | undefined>, opts);
  return data.discount_codes ?? data;
}

export async function getDiscountCode(
  priceRuleId: number | string,
  discountCodeId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const rid = encodeURIComponent(String(priceRuleId));
  const cid = encodeURIComponent(String(discountCodeId));
  const data = await shopifyGet<{ discount_code?: unknown }>(`/price_rules/${rid}/discount_codes/${cid}.json`, undefined, opts);
  return data.discount_code ?? data;
}

export async function updateDiscountCode(
  priceRuleId: number | string,
  discountCodeId: number | string,
  patch: { code?: string; usage_limit?: number | null },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const rid = encodeURIComponent(String(priceRuleId));
  const cid = encodeURIComponent(String(discountCodeId));
  const data = await shopifyWrite<{ discount_code?: unknown }>('PUT', `/price_rules/${rid}/discount_codes/${cid}.json`, { discount_code: patch }, opts);
  return data.discount_code ?? data;
}

export async function deleteDiscountCode(
  priceRuleId: number | string,
  discountCodeId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const rid = encodeURIComponent(String(priceRuleId));
  const cid = encodeURIComponent(String(discountCodeId));
  return shopifyWrite<unknown>('DELETE', `/price_rules/${rid}/discount_codes/${cid}.json`, undefined, opts);
}

// ============================================================================
// METAFIELDS
// ============================================================================

export async function listMetafields(
  params: {
    owner_resource?: string;
    owner_id?: number | string;
    namespace?: string;
    key?: string;
    limit?: number;
    page_info?: string;
    fields?: string;
  } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ metafields?: unknown[] }>('/metafields.json', params as Record<string, string | number | undefined>, opts);
  return data.metafields ?? data;
}

export async function getMetafield(
  metafieldId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(metafieldId));
  const data = await shopifyGet<{ metafield?: unknown }>(`/metafields/${id}.json`, undefined, opts);
  return data.metafield ?? data;
}

export async function createMetafield(
  metafield: {
    namespace: string;
    key: string;
    value: string;
    type: string;
    owner_resource?: string;
    owner_id?: number | string;
    description?: string;
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ metafield?: unknown }>('POST', '/metafields.json', { metafield }, opts);
  return data.metafield ?? data;
}

export async function updateMetafield(
  metafieldId: number | string,
  patch: { value: string; type?: string },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(metafieldId));
  const data = await shopifyWrite<{ metafield?: unknown }>('PUT', `/metafields/${id}.json`, { metafield: patch }, opts);
  return data.metafield ?? data;
}

export async function deleteMetafield(
  metafieldId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(metafieldId));
  return shopifyWrite<unknown>('DELETE', `/metafields/${id}.json`, undefined, opts);
}

// ============================================================================
// WEBHOOKS
// ============================================================================

export async function listWebhooks(
  params: { limit?: number; topic?: string; address?: string; fields?: string } = {},
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ webhooks?: unknown[] }>('/webhooks.json', params as Record<string, string | number | undefined>, opts);
  return data.webhooks ?? data;
}

export async function getWebhook(
  webhookId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(webhookId));
  const data = await shopifyGet<{ webhook?: unknown }>(`/webhooks/${id}.json`, undefined, opts);
  return data.webhook ?? data;
}

export async function createWebhook(
  webhook: {
    topic: string;
    address: string;
    format?: 'json' | 'xml';
    fields?: string[];
    metafield_namespaces?: string[];
  },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyWrite<{ webhook?: unknown }>('POST', '/webhooks.json', { webhook }, opts);
  return data.webhook ?? data;
}

export async function updateWebhook(
  webhookId: number | string,
  patch: { address?: string; fields?: string[]; metafield_namespaces?: string[] },
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(webhookId));
  const data = await shopifyWrite<{ webhook?: unknown }>('PUT', `/webhooks/${id}.json`, { webhook: patch }, opts);
  return data.webhook ?? data;
}

export async function deleteWebhook(
  webhookId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(webhookId));
  return shopifyWrite<unknown>('DELETE', `/webhooks/${id}.json`, undefined, opts);
}

// ============================================================================
// LOCATIONS
// ============================================================================

export async function listLocations(
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const data = await shopifyGet<{ locations?: unknown[] }>('/locations.json', undefined, opts);
  return data.locations ?? data;
}

export async function getLocation(
  locationId: number | string,
  opts: { correlationId?: string } = {},
): Promise<unknown> {
  const id = encodeURIComponent(String(locationId));
  const data = await shopifyGet<{ location?: unknown }>(`/locations/${id}.json`, undefined, opts);
  return data.location ?? data;
}
