/**
 * n8n Public API client for meta-tools (list workflows, get execution status, etc).
 * Separate from webhook-client.ts which is for HMAC-signed POST to workflow webhooks.
 */

import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { n8nReachable, N8N_DEGRADED } from './reachability.js';

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
        "Set N8N_API_KEY as a gateway secret. Value is in Matt's Notion Token Vault under n8n section.",
    });
  }
  return env.N8N_API_KEY;
}

/** Throws N8nApiError('n8n_degraded') when n8n itself is unreachable (see reachability.ts).
 *  Checked AFTER requireKey() so a genuinely unconfigured key still reports that specific,
 *  more actionable error rather than being masked behind a network-reachability message. */
async function assertN8nReachable(): Promise<void> {
  if (await n8nReachable()) return;
  throw new N8nApiError({ ...N8N_DEGRADED });
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
  /**
   * Optional hard ceiling for the decoded response body. When set, the body is
   * consumed as a byte stream and cancelled as soon as this limit is exceeded.
   * Omitted callers keep the existing unbounded `Response.text()` behavior.
   */
  maxResponseBytes?: number;
}

function boundedResponseError(status: number, code: string, message: string, nextStep: string): N8nApiError {
  return new N8nApiError({ code, status, message, nextStep });
}

async function readResponseText(res: Response, maxResponseBytes?: number): Promise<string> {
  if (maxResponseBytes === undefined) return res.text();

  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        try { await reader.cancel(); } catch { /* Preserve the sanitized size-limit failure. */ }
        throw boundedResponseError(
          res.status,
          'n8n_response_too_large',
          'n8n API response exceeded the configured byte limit.',
          'Request a smaller page or review the response-size limit.',
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof N8nApiError) throw err;
    throw boundedResponseError(
      res.status,
      'n8n_response_read_failed',
      'Unable to read the bounded n8n API response safely.',
      'Check n8n connectivity using the call correlation ID.',
    );
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled or errored reader may already be released. */ }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString('utf8');
}

export async function n8nGet<T = unknown>(path: string, opts: N8nGetOptions = {}): Promise<T> {
  if (opts.maxResponseBytes !== undefined && (!Number.isSafeInteger(opts.maxResponseBytes) || opts.maxResponseBytes < 1)) {
    throw new N8nApiError({
      code: 'n8n_invalid_response_limit',
      status: 0,
      message: 'The n8n response byte limit must be a positive safe integer.',
      nextStep: 'Use a positive response-size limit.',
    });
  }
  const key = requireKey();
  await assertN8nReachable();
  const base = env.N8N_BASE_URL.replace(/\/$/, '');
  const url = `${base}/api/v1${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
    const res = await fetchWithBudget(url, {
      method: 'GET',
      headers: {
        'x-n8n-api-key': key,
        accept: 'application/json',
      },
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries: 1 });
    const body = await readResponseText(res, opts.maxResponseBytes);
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'n8n_api_ok', path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId },
        'n8n api ok',
      );
      if (!body) return {} as T;
      try {
        return JSON.parse(body) as T;
      } catch (err) {
        if (opts.maxResponseBytes !== undefined) {
          throw boundedResponseError(
            res.status,
            'n8n_invalid_json',
            'n8n returned an invalid bounded API response.',
            'Check the n8n API response using the call correlation ID.',
          );
        }
        throw err;
      }
    }
    if (opts.maxResponseBytes !== undefined) {
      throw boundedResponseError(
        res.status,
        res.status === 401 || res.status === 403 ? 'n8n_auth_failed' : res.status === 404 ? 'n8n_not_found' : res.status >= 500 ? 'n8n_upstream_error' : 'n8n_request_error',
        `n8n returned ${res.status} for ${path}.`,
        'Check n8n connectivity and access using the call correlation ID.',
      );
    }
    throw mapError(res.status, path, body);
  } catch (err) {
    if (err instanceof N8nApiError) throw err;
    if (opts.maxResponseBytes !== undefined) {
      throw boundedResponseError(
        0,
        'n8n_network_error',
        'Unable to read the bounded n8n API response safely.',
        'Check n8n connectivity using the call correlation ID.',
      );
    }
    throw new N8nApiError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n API at ${path}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable (see reachability.ts's n8nReachable() gate above).`,
      upstream: err,
    });
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
      nextStep: 'Confirm N8N_API_KEY (a gateway secret) matches the Notion vault value. Note: n8n uses X-N8N-API-KEY header, not bearer.',
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
    nextStep: 'Check the AWS Lightsail recovery lane (cs-n8n.otchealthmart.com) instance health.',
    upstream,
  });
}
