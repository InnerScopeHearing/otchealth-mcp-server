import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

export class ShopifyApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'ShopifyApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireConfigured(): { shop: string; version: string; token: string } {
  if (!env.SHOPIFY_ACCESS_TOKEN || !env.SHOPIFY_SHOP) {
    throw new ShopifyApiError({
      code: 'shopify_not_configured',
      status: 0,
      message: 'Shopify integration is not configured.',
      nextStep:
        'Set SHOPIFY_SHOP and SHOPIFY_ACCESS_TOKEN in Railway env vars. Values are in Matt\'s Notion Token Vault under Shopify section.',
    });
  }
  return { shop: env.SHOPIFY_SHOP, version: env.SHOPIFY_API_VERSION, token: env.SHOPIFY_ACCESS_TOKEN };
}

function buildQuery(q?: Record<string, string | number | undefined>): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export interface ShopifyRestOptions {
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export async function shopifyRestGet<T = unknown>(path: string, opts: ShopifyRestOptions = {}): Promise<T> {
  const { shop, version, token } = requireConfigured();
  const url = `https://${shop}/admin/api/${version}${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'x-shopify-access-token': token,
        accept: 'application/json',
      },
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const body = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.debug(
        { type: 'shopify_rest_ok', path, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId },
        'shopify rest ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, body);
  } catch (err) {
    if (err instanceof ShopifyApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'shopify_rest_network_error',
        path,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'shopify network error',
    );
    throw new ShopifyApiError({
      code: 'shopify_network_error',
      status: 0,
      message: `Network error calling Shopify Admin API at ${path}: ${(err as Error).message}`,
      nextStep: 'Check Railway logs and Shopify status (https://www.shopifystatus.com/). Retry if transient.',
      upstream: err,
    });
  }
}

export async function shopifyRestWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: ShopifyRestOptions = {},
): Promise<T> {
  const { shop, version, token } = requireConfigured();
  const url = `https://${shop}/admin/api/${version}${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method,
      headers: {
        'x-shopify-access-token': token,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const text = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.info(
        { type: 'shopify_rest_write_ok', method, path, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId },
        'shopify rest write ok',
      );
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, text);
  } catch (err) {
    if (err instanceof ShopifyApiError) throw err;
    throw new ShopifyApiError({
      code: 'shopify_network_error',
      status: 0,
      message: `Network error calling Shopify Admin API (${method} ${path}): ${(err as Error).message}`,
      nextStep: 'Check gateway logs and https://www.shopifystatus.com/. Retry if transient.',
      upstream: err,
    });
  }
}

function mapError(status: number, path: string, body: string): ShopifyApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep string */ }
  if (status === 401 || status === 403) {
    return new ShopifyApiError({
      code: 'shopify_auth_failed',
      status,
      message: `Shopify Admin API rejected auth on ${path}.`,
      nextStep: 'Confirm SHOPIFY_ACCESS_TOKEN matches the value in Matt\'s Notion Token Vault (last rotated 2026-04-30). Rotate if leaked.',
      upstream,
    });
  }
  if (status === 404) {
    return new ShopifyApiError({
      code: 'shopify_not_found',
      status,
      message: `Shopify Admin API returned 404 for ${path}.`,
      nextStep: `Verify the ID exists at https://${env.SHOPIFY_SHOP}/admin/.`,
      upstream,
    });
  }
  if (status === 429) {
    return new ShopifyApiError({
      code: 'shopify_rate_limited',
      status,
      message: 'Shopify Admin API rate-limited the call.',
      nextStep: 'Back off 2-5 seconds and retry. Shopify uses a leaky-bucket; sequential reads are safest.',
      upstream,
    });
  }
  if (status >= 500) {
    return new ShopifyApiError({
      code: 'shopify_upstream_error',
      status,
      message: `Shopify returned ${status} for ${path}.`,
      nextStep: 'Shopify upstream error. Check https://www.shopifystatus.com/ and retry shortly.',
      upstream,
    });
  }
  return new ShopifyApiError({
    code: 'shopify_request_error',
    status,
    message: `Shopify returned ${status} for ${path}.`,
    nextStep: 'Verify the input parameters match the Shopify Admin API documentation.',
    upstream,
  });
}
