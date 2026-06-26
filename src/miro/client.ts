/**
 * Miro REST v2 client. Auth: Bearer MIRO_TOKEN. Inert (throws MiroApiError) when unset.
 * Docs: https://developers.miro.com/reference. Token in GCP Secret Manager (miro-token).
 */
import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const BASE = 'https://api.miro.com/v2';

export class MiroApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;
  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'MiroApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function token(): string {
  const t = loadEnv().MIRO_TOKEN;
  if (!t) {
    throw new MiroApiError({
      code: 'miro_not_configured',
      status: 0,
      message: 'Miro integration is not configured.',
      nextStep: 'Set MIRO_TOKEN on the gateway (value in GCP Secret Manager miro-token / Notion vault).',
    });
  }
  return t;
}

export interface MiroOpts { correlationId?: string; timeoutMs?: number }

export async function miroFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: MiroOpts = {},
): Promise<T> {
  const t = token();
  const url = `${BASE}${path}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${t}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const text = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.info({ type: 'miro_ok', method, path, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId }, 'miro ok');
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    let upstream: unknown = text;
    try { upstream = JSON.parse(text); } catch { /* keep string */ }
    throw new MiroApiError({
      code: res.statusCode === 401 || res.statusCode === 403 ? 'miro_auth_failed' : res.statusCode === 429 ? 'miro_rate_limited' : 'miro_request_error',
      status: res.statusCode,
      message: `Miro API ${res.statusCode} on ${method} ${path}.`,
      nextStep: res.statusCode === 401 || res.statusCode === 403 ? 'Confirm MIRO_TOKEN scopes (boards:read boards:write).' : 'Inspect upstream error; retry if transient.',
      upstream,
    });
  } catch (err) {
    if (err instanceof MiroApiError) throw err;
    throw new MiroApiError({ code: 'miro_network_error', status: 0, message: `Network error calling Miro (${method} ${path}): ${(err as Error).message}`, nextStep: 'Check gateway logs / Miro status.', upstream: err });
  }
}

export function miroConfigured(): boolean {
  return Boolean(loadEnv().MIRO_TOKEN);
}
