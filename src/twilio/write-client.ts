/**
 * Twilio Write Client
 *
 * Covers outbound SMS, MMS, and voice calls via the Twilio REST API.
 * All operations are TCPA-sensitive and classified write_orchestrated.
 *
 * Auth env vars reused (no new vars added):
 *   TWILIO_ACCOUNT_SID  — Account SID (both credential and URL path segment)
 *   TWILIO_AUTH_TOKEN   — HTTP Basic auth password
 *
 * New env var required:
 *   TWILIO_FROM_NUMBER  — The verified/purchased Twilio phone number (E.164,
 *                         e.g. +15005550006) used as the default From address.
 *                         Callers may override per-call for multi-number setups.
 *
 * Twilio REST API uses application/x-www-form-urlencoded for POST bodies.
 * Base URL: https://api.twilio.com/2010-04-01
 */

import { loadEnv } from '../config/env.js';
import { TwilioApiError } from './api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

const BASE = 'https://api.twilio.com/2010-04-01';

// ── Auth + credential guard ──────────────────────────────────────────────────

function requireCreds(): { sid: string; token: string } {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_ACCOUNT_SID is not set.',
      nextStep: 'Add TWILIO_ACCOUNT_SID to the MCP server environment (Railway secret).',
    });
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_AUTH_TOKEN is not set.',
      nextStep: 'Add TWILIO_AUTH_TOKEN to the MCP server environment (Railway secret).',
    });
  }
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
}

function basicAuth(creds: { sid: string; token: string }): string {
  return `Basic ${Buffer.from(`${creds.sid}:${creds.token}`, 'utf8').toString('base64')}`;
}

// ── Low-level form-encoded POST helper ───────────────────────────────────────

async function twilioPost<T = unknown>(
  path: string,
  params: Record<string, string>,
  _correlationId?: string,
): Promise<T> {
  const creds = requireCreds();
  const url = `${BASE}${path}`;
  const body = new URLSearchParams(params).toString();

  let statusCode: number;
  let text: string;
  try {
    // Non-idempotent write (outbound SMS/MMS/call): retries:0 so a timeout never sends
    // a duplicate message or call. TCPA-sensitive.
    const res = await fetchWithBudget(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    }, { timeoutMs: 30_000, retries: 0 });
    statusCode = res.status;
    text = await res.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio ${path}: ${(netErr as Error).message}`,
      nextStep:
        'Check Railway logs and https://status.twilio.com/. Retry if transient. ' +
        'Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN if persistent.',
      upstream: netErr,
    });
  }

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 200 && statusCode < 300) {
    return data as T;
  }

  throw mapTwilioError(statusCode, path, data);
}

// ── Error mapping ─────────────────────────────────────────────────────────────

function mapTwilioError(status: number, path: string, data: any): TwilioApiError {
  const twilioCode: string = data?.code ? String(data.code) : String(status);
  const message: string = data?.message ?? `Twilio HTTP ${status} on ${path}`;

  if (status === 401 || status === 403) {
    return new TwilioApiError({
      code: `twilio_auth_failed`,
      status,
      message: `Twilio rejected auth on ${path}: ${message}`,
      nextStep:
        'Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in the Notion Token Vault. Rotate if leaked.',
      upstream: data,
    });
  }
  if (status === 400) {
    return new TwilioApiError({
      code: `twilio_bad_request_${twilioCode}`,
      status,
      message: `Twilio rejected the request to ${path}: ${message}`,
      nextStep:
        'Check the Twilio error code at https://www.twilio.com/docs/errors. ' +
        'Common causes: invalid phone number format (must be E.164), unverified number for trial accounts, missing From.',
      upstream: data,
    });
  }
  if (status === 429) {
    return new TwilioApiError({
      code: 'twilio_rate_limited',
      status,
      message: `Twilio rate-limited the call to ${path}.`,
      nextStep: 'Back off and retry. Check account sending limits.',
      upstream: data,
    });
  }
  if (status >= 500) {
    return new TwilioApiError({
      code: 'twilio_upstream_error',
      status,
      message: `Twilio returned ${status} for ${path}: ${message}`,
      nextStep: 'Check https://status.twilio.com/ and retry after a few minutes.',
      upstream: data,
    });
  }
  return new TwilioApiError({
    code: `twilio_${twilioCode}`,
    status,
    message: `Twilio returned ${status} for ${path}: ${message}`,
    nextStep:
      `Look up Twilio error code ${twilioCode} at https://www.twilio.com/docs/errors for remediation steps.`,
    upstream: data,
  });
}

// ── Shared from-number resolution ─────────────────────────────────────────────

function resolveFrom(from?: string): string {
  const resolved = from ?? (env as any).TWILIO_FROM_NUMBER ?? '';
  if (!resolved) {
    throw new TwilioApiError({
      code: 'twilio_no_from_number',
      status: 0,
      message: 'No "from" phone number provided and TWILIO_FROM_NUMBER is not set.',
      nextStep:
        'Either pass "from" explicitly (E.164 format, e.g. +15005550006) or add TWILIO_FROM_NUMBER to the MCP server environment.',
    });
  }
  return resolved;
}

// ── Twilio resource types ─────────────────────────────────────────────────────

export interface TwilioMessage {
  sid: string;
  status: string;
  to: string;
  from: string;
  body?: string;
  num_media?: string;
  date_created?: string;
  [key: string]: unknown;
}

export interface TwilioCall {
  sid: string;
  status: string;
  to: string;
  from: string;
  direction: string;
  date_created?: string;
  [key: string]: unknown;
}

// ── Public write operations ───────────────────────────────────────────────────

/**
 * POST /Accounts/{SID}/Messages.json
 * Sends an outbound SMS message (text only, no media).
 * TCPA-sensitive — must only send to consenting recipients.
 */
export async function sendSms(args: {
  to: string;
  body: string;
  from?: string;
  status_callback?: string;
  correlationId?: string;
}): Promise<TwilioMessage> {
  const creds = requireCreds();
  const params: Record<string, string> = {
    To: args.to,
    From: resolveFrom(args.from),
    Body: args.body,
  };
  if (args.status_callback) params.StatusCallback = args.status_callback;
  return twilioPost<TwilioMessage>(
    `/Accounts/${creds.sid}/Messages.json`,
    params,
    args.correlationId,
  );
}

/**
 * POST /Accounts/{SID}/Messages.json
 * Sends an outbound MMS message (text + one or more media URLs).
 * TCPA-sensitive — must only send to consenting recipients.
 */
export async function sendMms(args: {
  to: string;
  body?: string;
  media_url: string[];
  from?: string;
  status_callback?: string;
  correlationId?: string;
}): Promise<TwilioMessage> {
  if (args.media_url.length === 0) {
    throw new TwilioApiError({
      code: 'twilio_mms_no_media',
      status: 0,
      message: 'MMS requires at least one media_url.',
      nextStep: 'Provide at least one publicly accessible media URL in the media_url array.',
    });
  }
  const creds = requireCreds();
  const params: Record<string, string> = {
    To: args.to,
    From: resolveFrom(args.from),
  };
  if (args.body) params.Body = args.body;
  // Twilio accepts repeated MediaUrl[] params; URLSearchParams handles first only,
  // so we build the form body manually for multiple media URLs.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  for (const mu of args.media_url) {
    parts.push(`MediaUrl=${encodeURIComponent(mu)}`);
  }
  if (args.status_callback) {
    parts.push(`StatusCallback=${encodeURIComponent(args.status_callback)}`);
  }

  // Use the low-level path directly with a pre-built body string
  const url = `${BASE}/Accounts/${creds.sid}/Messages.json`;
  const body = parts.join('&');
  let statusCode: number;
  let text: string;
  try {
    // Non-idempotent write (outbound MMS): retries:0 so a timeout never sends a
    // duplicate message. TCPA-sensitive.
    const res = await fetchWithBudget(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    }, { timeoutMs: 30_000, retries: 0 });
    statusCode = res.status;
    text = await res.text();
  } catch (netErr) {
    throw new TwilioApiError({
      code: 'twilio_network_error',
      status: 0,
      message: `Network error calling Twilio MMS: ${(netErr as Error).message}`,
      nextStep: 'Check Railway logs and https://status.twilio.com/. Retry if transient.',
      upstream: netErr,
    });
  }

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 200 && statusCode < 300) return data as TwilioMessage;
  throw mapTwilioError(statusCode, `/Accounts/.../Messages.json`, data);
}

/**
 * POST /Accounts/{SID}/Calls.json
 * Initiates an outbound voice call. A TwiML URL or TwiML Bin must be provided
 * to define what happens when the call is answered.
 * TCPA-sensitive — must only call consenting recipients.
 */
export async function makeCall(args: {
  to: string;
  twiml_url: string;          // URL that returns TwiML instructions for the call
  from?: string;
  status_callback?: string;
  status_callback_method?: 'GET' | 'POST';
  timeout?: number;           // seconds to let the call ring (default 60)
  record?: boolean;
  correlationId?: string;
}): Promise<TwilioCall> {
  const creds = requireCreds();
  const params: Record<string, string> = {
    To: args.to,
    From: resolveFrom(args.from),
    Url: args.twiml_url,
  };
  if (args.status_callback) params.StatusCallback = args.status_callback;
  if (args.status_callback_method) params.StatusCallbackMethod = args.status_callback_method;
  if (args.timeout !== undefined) params.Timeout = String(args.timeout);
  if (args.record !== undefined) params.Record = String(args.record);
  return twilioPost<TwilioCall>(
    `/Accounts/${creds.sid}/Calls.json`,
    params,
    args.correlationId,
  );
}
