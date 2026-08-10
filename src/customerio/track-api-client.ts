import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { CustomerIoApiError } from './app-api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

const BASE = 'https://track.customer.io/api/v1';

function basicAuthHeader(): string {
  const raw = `${env.CIO_SITE_ID}:${env.CIO_TRACK_KEY}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

export interface TrackApiOptions {
  timeoutMs?: number;
  correlationId?: string;
}

async function trackRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  opts: TrackApiOptions = {},
): Promise<unknown> {
  const url = `${BASE}${path}`;
  const started = Date.now();
  try {
    // GET is read-only (retries:1); trackEvent (POST) and identifyCustomer (PUT) are
    // non-idempotent writes, so every other method gets retries:0 to avoid a duplicate
    // tracked event or profile write on a timeout.
    const retries = method === 'GET' ? 1 : 0;
    const res = await fetchWithBudget(url, {
      method,
      headers: {
        authorization: basicAuthHeader(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { timeoutMs: opts.timeoutMs ?? 30_000, retries });
    const raw = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'cio_track_api_ok', method, path, status: res.status, latency_ms: latency, correlation_id: opts.correlationId },
        'cio track-api ok',
      );
      return raw ? safeJsonParse(raw) : { ok: true };
    }
    throw mapTrackError(res.status, method, path, raw);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'cio_track_api_network_error',
        method,
        path,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'cio track-api network error',
    );
    throw new CustomerIoApiError({
      code: 'cio_network_error',
      status: 0,
      message: `Network error calling Customer.io Track API ${method} ${path}: ${(err as Error).message}`,
      nextStep:
        'Check Azure Container Apps logs and Customer.io status. If persistent, verify Azure Key Vault secrets cio-site-id and cio-track-key are synchronized to the same-named Container Apps local secrets.',
      upstream: err,
    });
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}

function mapTrackError(
  status: number,
  method: string,
  path: string,
  body: string,
): CustomerIoApiError {
  let upstream: unknown = body;
  try {
    upstream = JSON.parse(body);
  } catch {
    /* keep as string */
  }
  if (status === 401 || status === 403) {
    return new CustomerIoApiError({
      code: 'cio_auth_failed',
      status,
      message: `Customer.io Track API rejected basic auth on ${method} ${path}.`,
      nextStep:
        'Confirm Azure Key Vault secrets cio-site-id and cio-track-key are synchronized to the same-named Container Apps local secrets. Track API uses HTTP Basic, not the App API bearer.',
      upstream,
    });
  }
  if (status === 400) {
    return new CustomerIoApiError({
      code: 'cio_bad_request',
      status,
      message: `Customer.io Track API rejected ${method} ${path} as malformed.`,
      nextStep: 'Verify identifier, event name, and payload shape match the Track API contract.',
      upstream,
    });
  }
  if (status === 429) {
    return new CustomerIoApiError({
      code: 'cio_rate_limited',
      status,
      message: 'Customer.io Track API rate-limited the call.',
      nextStep: 'Back off and retry. Reduce write batch size.',
      upstream,
    });
  }
  if (status >= 500) {
    return new CustomerIoApiError({
      code: 'cio_upstream_error',
      status,
      message: `Customer.io Track API returned ${status} for ${method} ${path}.`,
      nextStep: 'Check https://status.customer.io/ and retry shortly.',
      upstream,
    });
  }
  return new CustomerIoApiError({
    code: 'cio_request_error',
    status,
    message: `Customer.io Track API returned ${status} for ${method} ${path}.`,
    nextStep: 'Check the Track API docs for this endpoint.',
    upstream,
  });
}

/** POST /customers/{id}/events — track a Track-API event for a known identifier. */
export async function trackEvent(args: {
  identifier: string;
  identifierType: 'email' | 'id' | 'cio_id';
  name: string;
  data?: Record<string, unknown>;
  timestamp?: number;
  correlationId?: string;
}): Promise<unknown> {
  const encoded = encodeURIComponent(args.identifier);
  const path = `/customers/${encoded}/events`;
  const body: Record<string, unknown> = { name: args.name };
  if (args.data !== undefined) body.data = args.data;
  if (args.timestamp !== undefined) body.timestamp = args.timestamp;
  const opts: TrackApiOptions = {};
  if (args.correlationId !== undefined) opts.correlationId = args.correlationId;
  return trackRequest('POST', path, body, opts);
}

/** PUT /customers/{id} — identify/update a customer profile via Track API. */
export async function identifyCustomer(args: {
  identifier: string;
  attributes: Record<string, unknown>;
  correlationId?: string;
}): Promise<unknown> {
  const encoded = encodeURIComponent(args.identifier);
  const path = `/customers/${encoded}`;
  const opts: TrackApiOptions = {};
  if (args.correlationId !== undefined) opts.correlationId = args.correlationId;
  return trackRequest('PUT', path, args.attributes, opts);
}
