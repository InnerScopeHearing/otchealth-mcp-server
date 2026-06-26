/**
 * Gumroad WRITE client — NEW file, self-contained.
 * Auth pattern mirrors src/gumroad/api-client.ts exactly (access_token query
 * param, same GumroadApiError shape). This file is self-contained so the read
 * client is never modified (hard rule).
 *
 * Gumroad API v2 write surface (as of 2026):
 *   SUPPORTED:  enable product, disable product, update product (PUT /v2/products/{id}),
 *               update offer_code, update subscription (cancel only).
 *   NOT SUPPORTED by the API:
 *     - Create product  (no POST /v2/products)
 *     - Delete product  (no DELETE /v2/products/{id})
 *     - Create/delete variants (variant_categories managed through dashboard only)
 *     - Update variant price directly (variants are read via GET /v2/products/{id},
 *       price adjustments live on the variant_category; no dedicated PUT endpoint)
 *     - Create/delete sales or refunds via standard v2 API
 *       (refunds: POST /v2/sales/{id}/refund exists but is a separate scope)
 *   See: https://app.gumroad.com/api#products
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();
const BASE = 'https://api.gumroad.com/v2';

// ---- Error class (mirrors GumroadApiError) ----

export class GumroadWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GumroadWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.GUMROAD_ACCESS_TOKEN) {
    throw new GumroadWriteError({
      code: 'gumroad_not_configured',
      status: 0,
      message: 'GUMROAD_ACCESS_TOKEN is not set.',
      nextStep: 'Add GUMROAD_ACCESS_TOKEN to the MCP server environment from the Notion API Vault.',
    });
  }
  return env.GUMROAD_ACCESS_TOKEN;
}

/**
 * Gumroad v2 write requests use application/x-www-form-urlencoded bodies
 * (not JSON) for PUT/POST/DELETE. access_token is included in the body for
 * mutating calls. See official Gumroad API docs.
 */
async function gumroadMutate<T = any>(
  method: 'PUT' | 'POST' | 'DELETE',
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
    throw new GumroadWriteError({
      code: `gumroad_${statusCode}`,
      status: statusCode,
      message: data?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Gumroad API response. Ensure GUMROAD_ACCESS_TOKEN is valid (Settings > Advanced > Applications) and has edit_products scope.',
      upstream: data,
    });
  }
  return data as T;
}

// ===========================================================================
// Write operations
// ===========================================================================

// ---- Enable product ----

export async function enableProduct(productId: string): Promise<any> {
  return gumroadMutate('PUT', `/products/${productId}/enable`);
}

// ---- Disable product ----

export async function disableProduct(productId: string): Promise<any> {
  return gumroadMutate('PUT', `/products/${productId}/disable`);
}

// ---- Update product ----

export interface UpdateProductOpts {
  product_id: string;
  name?: string;
  /** Price in cents (USD). Gumroad stores prices in cents. */
  price?: number;
  description?: string;
  /** Custom permalink slug */
  url?: string;
  /** "true" to accept pay-what-you-want */
  customizable_price?: boolean;
  /** Suggested pay-what-you-want price in cents */
  suggested_price?: number;
}

export async function updateProduct(opts: UpdateProductOpts): Promise<any> {
  const { product_id, ...fields } = opts;
  const strFields: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) strFields[k] = v;
  }
  return gumroadMutate('PUT', `/products/${product_id}`, strFields);
}
