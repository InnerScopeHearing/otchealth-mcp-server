import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { CustomerIoApiError } from './app-api-client.js';

const BASE = 'https://us.fly.customer.io';
const TOKEN_PATH = '/v1/service_accounts/oauth/token';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

export interface FlyRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  correlationId?: string;
}

function buildQuery(query?: FlyRequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function serviceAccountToken(): string {
  const token = loadEnv().CIO_FLY_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new CustomerIoApiError({
      code: 'cio_fly_not_configured',
      status: 0,
      message: 'Customer.io Journeys UI API service-account authentication is not configured.',
      nextStep:
        'Create a least-privilege Customer.io system service-account token, store it in Azure Key Vault kv-otc-55c84f6bef as cio-fly-service-account-token, and bind the Container Apps secret cio-fly-service-account-token to CIO_FLY_SERVICE_ACCOUNT_TOKEN.',
    });
  }
  return token;
}

async function exchangeServiceAccountToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAtMs - TOKEN_EXPIRY_SKEW_MS) {
    return cachedToken.value;
  }

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_secret: serviceAccountToken(),
  });
  let response: Response;
  try {
    response = await fetchWithBudget(
      `${BASE}${TOKEN_PATH}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'x-cio-agent': '1',
          'x-cio-source': 'OTCHealth governed gateway',
        },
        body: form.toString(),
      },
      { timeoutMs: 15_000, retries: 0 },
    );
  } catch (error) {
    throw new CustomerIoApiError({
      code: 'cio_fly_token_network_error',
      status: 0,
      message: `Network error exchanging the Customer.io service-account token: ${(error as Error).message}`,
      nextStep: 'Check Azure Container Apps networking and Customer.io status. Do not retry a mutating tool until authentication is healthy.',
      upstream: error,
    });
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  if (!response.ok || typeof parsed.access_token !== 'string') {
    throw new CustomerIoApiError({
      code: 'cio_fly_token_exchange_failed',
      status: response.status,
      message: `Customer.io service-account token exchange failed with HTTP ${response.status}.`,
      nextStep:
        'Verify CIO_FLY_SERVICE_ACCOUNT_TOKEN is the current least-privilege token from Azure Key Vault kv-otc-55c84f6bef secret cio-fly-service-account-token.',
      upstream: parsed,
    });
  }

  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
    ? Math.max(60, parsed.expires_in)
    : 3600;
  cachedToken = {
    value: parsed.access_token,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
  return cachedToken.value;
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mapFlyError(status: number, method: string, path: string, upstream: unknown): CustomerIoApiError {
  if (status === 401 || status === 403) {
    return new CustomerIoApiError({
      code: 'cio_fly_auth_failed',
      status,
      message: `Customer.io Journeys UI API rejected ${method} ${path}.`,
      nextStep:
        'Verify the least-privilege Customer.io service-account role permits this endpoint and that Azure Key Vault secret cio-fly-service-account-token is bound to CIO_FLY_SERVICE_ACCOUNT_TOKEN.',
      upstream,
    });
  }
  if (status === 404) {
    return new CustomerIoApiError({
      code: 'cio_fly_not_found',
      status,
      message: `Customer.io Journeys UI API returned 404 for ${method} ${path}.`,
      nextStep: 'Verify the workspace/resource ID and confirm the endpoint in the current official Customer.io OpenAPI schema.',
      upstream,
    });
  }
  if (status === 409 || status === 412) {
    return new CustomerIoApiError({
      code: 'cio_fly_conflict',
      status,
      message: `Customer.io Journeys UI API rejected ${method} ${path} because current state changed.`,
      nextStep: 'Re-read the resource, rebuild the dry-run plan from current state, and obtain a new approval reference before retrying.',
      upstream,
    });
  }
  if (status === 422 || status === 400) {
    return new CustomerIoApiError({
      code: 'cio_fly_validation_failed',
      status,
      message: `Customer.io Journeys UI API rejected the schema for ${method} ${path}.`,
      nextStep: 'Re-check the current official OpenAPI request schema and correct the dry-run payload; do not bypass strict validation.',
      upstream,
    });
  }
  if (status === 429) {
    return new CustomerIoApiError({
      code: 'cio_fly_rate_limited',
      status,
      message: `Customer.io rate-limited ${method} ${path}.`,
      nextStep: 'Honor the provider limit and retry later. Mutating calls are never retried automatically.',
      upstream,
    });
  }
  if (status >= 500) {
    return new CustomerIoApiError({
      code: 'cio_fly_upstream_error',
      status,
      message: `Customer.io Journeys UI API returned HTTP ${status} for ${method} ${path}.`,
      nextStep: 'Check Customer.io status and retry only after the upstream incident clears. Mutating calls are never retried automatically.',
      upstream,
    });
  }
  return new CustomerIoApiError({
    code: 'cio_fly_request_failed',
    status,
    message: `Customer.io Journeys UI API returned HTTP ${status} for ${method} ${path}.`,
    nextStep: 'Inspect the current resource and official request schema before retrying.',
    upstream,
  });
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: FlyRequestOptions,
  allowAuthRefresh = true,
): Promise<unknown> {
  const token = await exchangeServiceAccountToken();
  const url = `${BASE}${path}${buildQuery(options.query)}`;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchWithBudget(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'x-validate': 'strict',
          'x-cio-agent': '1',
          'x-cio-source': 'OTCHealth governed gateway',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
      {
        timeoutMs: options.timeoutMs ?? 20_000,
        retries: method === 'GET' ? 1 : 0,
      },
    );
  } catch (error) {
    logger.error(
      {
        type: 'cio_fly_network_error',
        method,
        path,
        latency_ms: Date.now() - started,
        correlation_id: options.correlationId,
        error: (error as Error).message,
      },
      'cio fly api network error',
    );
    throw new CustomerIoApiError({
      code: 'cio_fly_network_error',
      status: 0,
      message: `Network error calling Customer.io Journeys UI API ${method} ${path}: ${(error as Error).message}`,
      nextStep: 'Check Azure Container Apps networking and Customer.io status. Mutating calls are never retried automatically.',
      upstream: error,
    });
  }

  if (response.status === 401 && allowAuthRefresh) {
    cachedToken = null;
    await exchangeServiceAccountToken(true);
    return request(method, path, options, false);
  }

  const text = await response.text();
  const body = parseBody(text);
  if (!response.ok) throw mapFlyError(response.status, method, path, body);

  logger.debug(
    {
      type: 'cio_fly_api_ok',
      method,
      path,
      status: response.status,
      latency_ms: Date.now() - started,
      correlation_id: options.correlationId,
    },
    'cio fly api ok',
  );
  return body;
}

export async function flyGet(path: string, options: Omit<FlyRequestOptions, 'body'> = {}): Promise<unknown> {
  return request('GET', path, options);
}

export async function flyQuery(path: string, body: unknown, options: Omit<FlyRequestOptions, 'body'> = {}): Promise<unknown> {
  return request('POST', path, { ...options, body });
}

export async function flyWrite(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  options: Omit<FlyRequestOptions, 'body'> = {},
): Promise<unknown> {
  return request(method, path, { ...options, body });
}

/** Test-only token-cache reset; does not expose credential material. */
export function resetCioFlyTokenCacheForTests(): void {
  cachedToken = null;
}
