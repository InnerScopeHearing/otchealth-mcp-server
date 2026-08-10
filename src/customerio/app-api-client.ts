import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

const BASE = 'https://api.customer.io/v1';

export interface AppApiOptions {
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export class CustomerIoApiError extends Error {
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
    this.name = 'CustomerIoApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }

  toToolError(): {
    error_code: string;
    error_message: string;
    next_step: string;
    upstream_status?: number;
  } {
    return {
      error_code: this.code,
      error_message: this.message,
      next_step: this.nextStep,
      upstream_status: this.status,
    };
  }
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

export async function appApiGet<T = unknown>(
  path: string,
  opts: AppApiOptions = {},
): Promise<T> {
  const url = `${BASE}${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
    const res = await fetchWithBudget(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${env.CIO_APP_API_BEARER}`,
        accept: 'application/json',
      },
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries: 1 });
    const body = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'cio_app_api_ok', path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId },
        'cio app-api ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapAppApiError(res.status, path, body);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'cio_app_api_network_error',
        path,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'cio app-api network error',
    );
    throw new CustomerIoApiError({
      code: 'cio_network_error',
      status: 0,
      message: `Network error calling Customer.io App API at ${path}: ${(err as Error).message}`,
      nextStep:
        'Check Azure Container Apps logs and Customer.io status. If persistent, verify Azure Key Vault kv-otc-55c84f6bef secret cio-app-api-bearer is synchronized to Container Apps local secret cio-app-bearer.',
      upstream: err,
    });
  }
}

function mapAppApiError(status: number, path: string, body: string): CustomerIoApiError {
  let upstream: unknown = body;
  try {
    upstream = JSON.parse(body);
  } catch {
    /* leave as string */
  }
  if (status === 401 || status === 403) {
    return new CustomerIoApiError({
      code: 'cio_auth_failed',
      status,
      message: `Customer.io App API rejected auth on ${path}.`,
      nextStep:
        'Confirm Azure Key Vault kv-otc-55c84f6bef secret cio-app-api-bearer is current and synchronize it to Container Apps local secret cio-app-bearer before rolling a safe revision.',
      upstream,
    });
  }
  if (status === 404) {
    return new CustomerIoApiError({
      code: 'cio_not_found',
      status,
      message: `Customer.io App API returned 404 for ${path}.`,
      nextStep: `Verify the ID exists at https://fly.customer.io/env/${env.CIO_WORKSPACE_ID}/ or list the parent collection first.`,
      upstream,
    });
  }
  if (status === 429) {
    return new CustomerIoApiError({
      code: 'cio_rate_limited',
      status,
      message: `Customer.io App API rate-limited the call to ${path}.`,
      nextStep: 'Back off 30-60 seconds and retry. Reduce concurrent calls.',
      upstream,
    });
  }
  if (status >= 500) {
    return new CustomerIoApiError({
      code: 'cio_upstream_error',
      status,
      message: `Customer.io App API returned ${status} for ${path}.`,
      nextStep:
        'Customer.io upstream error. Check https://status.customer.io/ and retry after a few minutes.',
      upstream,
    });
  }
  return new CustomerIoApiError({
    code: 'cio_request_error',
    status,
    message: `Customer.io App API returned ${status} for ${path}.`,
    nextStep: 'Verify the input parameters match the App API documentation.',
    upstream,
  });
}
 match the App API documentation.',
    upstream,
  });
}
