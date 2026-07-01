/**
 * Customer.io Write Client
 *
 * Covers Track API (identify/delete/suppress/unsuppress via basic auth)
 * and App API (transactional email, campaign trigger via bearer auth).
 *
 * Auth env vars reused (no new vars added):
 *   CIO_SITE_ID + CIO_TRACK_KEY  — Track API basic auth
 *   CIO_APP_API_BEARER            — App API bearer
 *
 * Ring-safety: any operation targeting an identifier that contains
 * "medreview" (case-insensitive) is refused before the network call,
 * mirroring the read-client carve for PHI projects.
 */

import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { CustomerIoApiError } from './app-api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ── Auth helpers ────────────────────────────────────────────────────────────

function trackBasicAuth(): string {
  const raw = `${env.CIO_SITE_ID}:${env.CIO_TRACK_KEY}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function appBearerAuth(): string {
  return `Bearer ${env.CIO_APP_API_BEARER}`;
}

// ── Ring-safety guard ────────────────────────────────────────────────────────

function guardMedreview(label: string, value: string): void {
  if (/medreview/i.test(value)) {
    throw new CustomerIoApiError({
      code: 'cio_phi_write_blocked',
      status: 403,
      message: `Write refused: "${label}" contains "medreview" — PHI project writes are blocked at the gateway level.`,
      nextStep:
        'MedReview project data must never be written via the MCP gateway. ' +
        'If this is legitimate, perform the operation directly in the Customer.io UI with appropriate PHI controls.',
    });
  }
}

// ── Low-level request helpers ─────────────────────────────────────────────────

const TRACK_BASE = 'https://track.customer.io/api/v1';
const APP_BASE = 'https://api.customer.io/v1';

async function trackWrite(
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  correlationId?: string,
): Promise<unknown> {
  const url = `${TRACK_BASE}${path}`;
  const started = Date.now();
  try {
    // Non-idempotent write (create/update/delete/suppress/unsuppress a customer
    // profile): retries:0 so a timeout never causes a duplicate mutation.
    const res = await fetchWithBudget(url, {
      method,
      headers: {
        authorization: trackBasicAuth(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, { timeoutMs: 30_000, retries: 0 });
    const raw = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'cio_track_write_ok', method, path, status: res.status, latency_ms: latency, correlation_id: correlationId },
        'cio track write ok',
      );
      return raw ? safeJsonParse(raw) : { ok: true };
    }
    throw mapTrackError(res.status, method, path, raw);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      { type: 'cio_track_write_network_error', method, path, latency_ms: latency, correlation_id: correlationId, err: (err as Error).message },
      'cio track write network error',
    );
    throw new CustomerIoApiError({
      code: 'cio_network_error',
      status: 0,
      message: `Network error calling Customer.io Track API ${method} ${path}: ${(err as Error).message}`,
      nextStep:
        'Check Railway logs and Customer.io status page. Retry if transient. Verify CIO_SITE_ID + CIO_TRACK_KEY if persistent.',
      upstream: err,
    });
  }
}

async function appWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  correlationId?: string,
): Promise<T> {
  const url = `${APP_BASE}${path}`;
  const started = Date.now();
  try {
    // Non-idempotent write (send a transactional email, trigger a broadcast send to
    // a whole campaign audience): retries:0 so a timeout never causes a duplicate send.
    const res = await fetchWithBudget(url, {
      method,
      headers: {
        authorization: appBearerAuth(),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, { timeoutMs: 30_000, retries: 0 });
    const raw = await res.text();
    const latency = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      logger.debug(
        { type: 'cio_app_write_ok', method, path, status: res.status, latency_ms: latency, correlation_id: correlationId },
        'cio app write ok',
      );
      return raw ? (JSON.parse(raw) as T) : ({} as T);
    }
    throw mapAppError(res.status, path, raw);
  } catch (err) {
    if (err instanceof CustomerIoApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      { type: 'cio_app_write_network_error', method, path, latency_ms: latency, correlation_id: correlationId, err: (err as Error).message },
      'cio app write network error',
    );
    throw new CustomerIoApiError({
      code: 'cio_network_error',
      status: 0,
      message: `Network error calling Customer.io App API ${method} ${path}: ${(err as Error).message}`,
      nextStep:
        'Check Railway logs and Customer.io status page. Retry if transient. Verify CIO_APP_API_BEARER if persistent.',
      upstream: err,
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function mapTrackError(status: number, method: string, path: string, body: string): CustomerIoApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep string */ }
  if (status === 401 || status === 403) {
    return new CustomerIoApiError({
      code: 'cio_auth_failed', status,
      message: `Customer.io Track API rejected basic auth on ${method} ${path}.`,
      nextStep: 'Confirm CIO_SITE_ID + CIO_TRACK_KEY match the Notion vault. Track API uses HTTP Basic, NOT bearer.',
      upstream,
    });
  }
  if (status === 400) {
    return new CustomerIoApiError({
      code: 'cio_bad_request', status,
      message: `Customer.io Track API rejected ${method} ${path} as malformed.`,
      nextStep: 'Verify identifier, payload shape, and required fields match the Track API contract.',
      upstream,
    });
  }
  if (status === 404) {
    return new CustomerIoApiError({
      code: 'cio_not_found', status,
      message: `Customer.io Track API returned 404 for ${method} ${path}.`,
      nextStep: 'Verify the customer identifier exists in this workspace.',
      upstream,
    });
  }
  if (status === 429) {
    return new CustomerIoApiError({
      code: 'cio_rate_limited', status,
      message: 'Customer.io Track API rate-limited the call.',
      nextStep: 'Back off 30-60 s and retry. Reduce write batch size.',
      upstream,
    });
  }
  if (status >= 500) {
    return new CustomerIoApiError({
      code: 'cio_upstream_error', status,
      message: `Customer.io Track API returned ${status} for ${method} ${path}.`,
      nextStep: 'Check https://status.customer.io/ and retry shortly.',
      upstream,
    });
  }
  return new CustomerIoApiError({
    code: 'cio_request_error', status,
    message: `Customer.io Track API returned ${status} for ${method} ${path}.`,
    nextStep: 'Check the Track API docs for this endpoint.',
    upstream,
  });
}

function mapAppError(status: number, path: string, body: string): CustomerIoApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep string */ }
  if (status === 401 || status === 403) {
    return new CustomerIoApiError({
      code: 'cio_auth_failed', status,
      message: `Customer.io App API rejected auth on ${path}.`,
      nextStep: 'Confirm CIO_APP_API_BEARER matches the current value in the Notion Token Vault. Rotate if leaked.',
      upstream,
    });
  }
  if (status === 404) {
    return new CustomerIoApiError({
      code: 'cio_not_found', status,
      message: `Customer.io App API returned 404 for ${path}.`,
      nextStep: 'Verify the campaign/message ID exists in the Customer.io workspace.',
      upstream,
    });
  }
  if (status === 400) {
    return new CustomerIoApiError({
      code: 'cio_bad_request', status,
      message: `Customer.io App API rejected the request to ${path} as malformed.`,
      nextStep: 'Check required fields: transactional_message_id, to, identifiers. Review App API docs.',
      upstream,
    });
  }
  if (status === 429) {
    return new CustomerIoApiError({
      code: 'cio_rate_limited', status,
      message: `Customer.io App API rate-limited the call to ${path}.`,
      nextStep: 'Back off 30-60 s and retry.',
      upstream,
    });
  }
  if (status >= 500) {
    return new CustomerIoApiError({
      code: 'cio_upstream_error', status,
      message: `Customer.io App API returned ${status} for ${path}.`,
      nextStep: 'Check https://status.customer.io/ and retry after a few minutes.',
      upstream,
    });
  }
  return new CustomerIoApiError({
    code: 'cio_request_error', status,
    message: `Customer.io App API returned ${status} for ${path}.`,
    nextStep: 'Verify the input parameters match the App API documentation.',
    upstream,
  });
}

// ── Public write operations ───────────────────────────────────────────────────

/**
 * Track API PUT /customers/{id}
 * Creates or updates (identifies) a customer profile.
 * If the customer does not exist, Customer.io creates them.
 */
export async function createOrUpdateCustomer(args: {
  identifier: string;
  attributes?: Record<string, unknown>;
  correlationId?: string;
}): Promise<unknown> {
  guardMedreview('identifier', args.identifier);
  const encoded = encodeURIComponent(args.identifier);
  return trackWrite('PUT', `/customers/${encoded}`, args.attributes ?? {}, args.correlationId);
}

/**
 * Track API DELETE /customers/{id}
 * Permanently deletes a customer profile from the workspace.
 */
export async function deleteCustomer(args: {
  identifier: string;
  correlationId?: string;
}): Promise<unknown> {
  guardMedreview('identifier', args.identifier);
  const encoded = encodeURIComponent(args.identifier);
  return trackWrite('DELETE', `/customers/${encoded}`, undefined, args.correlationId);
}

/**
 * Track API POST /customers/{id}/suppress
 * Suppresses a customer — they will no longer receive messages.
 */
export async function suppressCustomer(args: {
  identifier: string;
  correlationId?: string;
}): Promise<unknown> {
  guardMedreview('identifier', args.identifier);
  const encoded = encodeURIComponent(args.identifier);
  return trackWrite('POST', `/customers/${encoded}/suppress`, undefined, args.correlationId);
}

/**
 * Track API POST /customers/{id}/unsuppress
 * Removes suppression from a customer, restoring messaging eligibility.
 */
export async function unsuppressCustomer(args: {
  identifier: string;
  correlationId?: string;
}): Promise<unknown> {
  guardMedreview('identifier', args.identifier);
  const encoded = encodeURIComponent(args.identifier);
  return trackWrite('POST', `/customers/${encoded}/unsuppress`, undefined, args.correlationId);
}

/**
 * App API POST /v1/send/email
 * Sends a transactional email using a pre-built transactional message template.
 * Requires a transactional_message_id. to.id or to.email must be provided.
 */
export interface SendTransactionalArgs {
  transactional_message_id: string | number;
  to: string;                          // recipient email address
  identifiers: { email?: string; id?: string };
  message_data?: Record<string, unknown>;
  from?: string;
  reply_to?: string;
  bcc?: string;
  subject?: string;                    // override template subject
  disable_message_retention?: boolean;
  send_to_unsubscribed?: boolean;
  tracked?: boolean;
  queue_draft?: boolean;
  disable_css_preprocessing?: boolean;
  correlationId?: string;
}

export interface SendTransactionalResponse {
  delivery_id: string;
  queued_at: number;
}

export async function sendTransactional(
  args: SendTransactionalArgs,
): Promise<SendTransactionalResponse> {
  const { correlationId, ...rest } = args;
  const body: Record<string, unknown> = {
    transactional_message_id: rest.transactional_message_id,
    to: rest.to,
    identifiers: rest.identifiers,
  };
  if (rest.message_data !== undefined) body.message_data = rest.message_data;
  if (rest.from !== undefined) body.from = rest.from;
  if (rest.reply_to !== undefined) body.reply_to = rest.reply_to;
  if (rest.bcc !== undefined) body.bcc = rest.bcc;
  if (rest.subject !== undefined) body.subject = rest.subject;
  if (rest.disable_message_retention !== undefined) body.disable_message_retention = rest.disable_message_retention;
  if (rest.send_to_unsubscribed !== undefined) body.send_to_unsubscribed = rest.send_to_unsubscribed;
  if (rest.tracked !== undefined) body.tracked = rest.tracked;
  if (rest.queue_draft !== undefined) body.queue_draft = rest.queue_draft;
  if (rest.disable_css_preprocessing !== undefined) body.disable_css_preprocessing = rest.disable_css_preprocessing;
  return appWrite<SendTransactionalResponse>('POST', '/send/email', body, correlationId);
}

/**
 * App API POST /v1/campaigns/{campaign_id}/triggers
 * Triggers a broadcast campaign send. Use with caution — this initiates
 * a mass-send to all recipients in the campaign's audience.
 */
export interface TriggerBroadcastArgs {
  campaign_id: number;
  data?: Record<string, unknown>;
  recipients?: {
    segment?: { id: number };
    emails?: string[];
  };
  correlationId?: string;
}

export interface TriggerBroadcastResponse {
  id: number;
  [key: string]: unknown;
}

export async function triggerBroadcast(
  args: TriggerBroadcastArgs,
): Promise<TriggerBroadcastResponse> {
  const { campaign_id, correlationId, ...rest } = args;
  const body: Record<string, unknown> = {};
  if (rest.data !== undefined) body.data = rest.data;
  if (rest.recipients !== undefined) body.recipients = rest.recipients;
  return appWrite<TriggerBroadcastResponse>(
    'POST',
    `/campaigns/${campaign_id}/triggers`,
    body,
    correlationId,
  );
}
