import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

const BASE = 'https://api.intercom.io';

export class IntercomApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'IntercomApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireToken(): string {
  if (!env.INTERCOM_ACCESS_TOKEN) {
    throw new IntercomApiError({
      code: 'intercom_not_configured',
      status: 0,
      message: 'Intercom integration is not configured.',
      nextStep:
        'Set INTERCOM_ACCESS_TOKEN in Railway env vars. Value is in Matt\'s Notion Token Vault under Intercom section.',
    });
  }
  return env.INTERCOM_ACCESS_TOKEN;
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

export interface IntercomGetOptions {
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export async function intercomGet<T = unknown>(path: string, opts: IntercomGetOptions = {}): Promise<T> {
  const token = requireToken();
  const url = `${BASE}${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
    const res = await fetchWithBudget(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'intercom-version': '2.11',
      },
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries: 1 });
    const body = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'intercom_ok', path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId },
        'intercom ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.status, path, body);
  } catch (err) {
    if (err instanceof IntercomApiError) throw err;
    throw new IntercomApiError({
      code: 'intercom_network_error',
      status: 0,
      message: `Network error calling Intercom API at ${path}: ${(err as Error).message}`,
      nextStep: 'Check Railway logs. Retry if transient.',
      upstream: err,
    });
  }
}

function mapError(status: number, path: string, body: string): IntercomApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep */ }
  if (status === 401 || status === 403) {
    return new IntercomApiError({
      code: 'intercom_auth_failed',
      status,
      message: `Intercom rejected auth on ${path}.`,
      nextStep: 'Confirm INTERCOM_ACCESS_TOKEN in Railway matches the Notion vault value.',
      upstream,
    });
  }
  if (status === 404) {
    return new IntercomApiError({
      code: 'intercom_not_found',
      status,
      message: `Intercom returned 404 for ${path}.`,
      nextStep: 'Verify the article/conversation/contact ID. Try list_articles to find valid IDs.',
      upstream,
    });
  }
  if (status === 429) {
    return new IntercomApiError({
      code: 'intercom_rate_limited',
      status,
      message: 'Intercom rate-limited the call.',
      nextStep: 'Back off and retry.',
      upstream,
    });
  }
  return new IntercomApiError({
    code: status >= 500 ? 'intercom_upstream_error' : 'intercom_request_error',
    status,
    message: `Intercom returned ${status} for ${path}.`,
    nextStep: status >= 500 ? 'Check https://www.intercomstatus.com/ and retry.' : 'Verify input parameters against Intercom API docs.',
    upstream,
  });
}
