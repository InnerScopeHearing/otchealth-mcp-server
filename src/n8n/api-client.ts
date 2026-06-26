/**
 * n8n Public API client for meta-tools (list workflows, get execution status, etc).
 * Separate from webhook-client.ts which is for HMAC-signed POST to workflow webhooks.
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

export class N8nApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'N8nApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.N8N_API_KEY) {
    throw new N8nApiError({
      code: 'n8n_not_configured',
      status: 0,
      message: 'n8n public API is not configured.',
      nextStep:
        'Set N8N_API_KEY in Railway env vars. Value is in Matt\'s Notion Token Vault under n8n section.',
    });
  }
  return env.N8N_API_KEY;
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

export interface N8nGetOptions {
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export async function n8nGet<T = unknown>(path: string, opts: N8nGetOptions = {}): Promise<T> {
  const key = requireKey();
  const base = env.N8N_BASE_URL.replace(/\/$/, '');
  const url = `${base}/api/v1${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'x-n8n-api-key': key,
        accept: 'application/json',
      },
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const body = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.debug(
        { type: 'n8n_api_ok', path, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId },
        'n8n api ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, body);
  } catch (err) {
    if (err instanceof N8nApiError) throw err;
    throw new N8nApiError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n API at ${path}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable. Check Railway logs.`,
      upstream: err,
    });
  }
}

export async function n8nWrite<T = unknown>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, opts: N8nGetOptions = {}): Promise<T> {
  const key = requireKey();
  const base = env.N8N_BASE_URL.replace(/\/$/, '');
  const url = `${base}/api/v1${path}${buildQuery(opts.query)}`;
  try {
    const res = await request(url, {
      method,
      headers: { 'x-n8n-api-key': key, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.info({ type: 'n8n_api_write_ok', method, path, status: res.statusCode, correlation_id: opts.correlationId }, 'n8n write ok');
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, text);
  } catch (err) {
    if (err instanceof N8nApiError) throw err;
    throw new N8nApiError({ code: 'n8n_network_error', status: 0, message: `Network error calling n8n API (${method} ${path}): ${(err as Error).message}`, nextStep: `Verify ${env.N8N_BASE_URL} is reachable.`, upstream: err });
  }
}

function mapError(status: number, path: string, body: string): N8nApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep */ }
  if (status === 401 || status === 403) {
    return new N8nApiError({
      code: 'n8n_auth_failed',
      status,
      message: `n8n API rejected auth on ${path}.`,
      nextStep: 'Confirm N8N_API_KEY in Railway matches the Notion vault value. Note: n8n uses X-N8N-API-KEY header, not bearer.',
      upstream,
    });
  }
  if (status === 404) {
    return new N8nApiError({
      code: 'n8n_not_found',
      status,
      message: `n8n returned 404 for ${path}.`,
      nextStep: 'Verify the workflow / execution ID. Use n8n_list_workflows to find IDs.',
      upstream,
    });
  }
  return new N8nApiError({
    code: status >= 500 ? 'n8n_upstream_error' : 'n8n_request_error',
    status,
    message: `n8n returned ${status} for ${path}.`,
    nextStep: 'Check n8n.cloud status or your Hetzner instance.',
    upstream,
  });
}
