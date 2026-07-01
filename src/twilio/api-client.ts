import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class TwilioApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'TwilioApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireCreds(): { sid: string; token: string } {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_ACCOUNT_SID is not set.',
      nextStep: 'Add TWILIO_ACCOUNT_SID to the MCP server environment.',
    });
  }
  if (!env.TWILIO_AUTH_TOKEN) {
    throw new TwilioApiError({
      code: 'twilio_not_configured',
      status: 0,
      message: 'TWILIO_AUTH_TOKEN is not set.',
      nextStep: 'Add TWILIO_AUTH_TOKEN to the MCP server environment.',
    });
  }
  return { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN };
}

const BASE = 'https://api.twilio.com';

async function twilioRequest<T = unknown>(url: string, creds: { sid: string; token: string }): Promise<T> {
  const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString('base64');
  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(url, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
    },
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new TwilioApiError({
      code: `twilio_${data.code ?? statusCode}`,
      status: statusCode,
      message: data.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check Twilio API error details. Ensure TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are valid.',
      upstream: data,
    });
  }
  return data as T;
}

// ----- Read-only endpoints -----

export async function getBalance(): Promise<{ currency: string; balance: string }> {
  const creds = requireCreds();
  const data = await twilioRequest<{ currency: string; balance: string }>(
    `${BASE}/2010-04-01/Accounts/${creds.sid}/Balance.json`,
    creds,
  );
  return { currency: data.currency, balance: data.balance };
}

export async function listMessages(limit = 20): Promise<any[]> {
  const creds = requireCreds();
  const data = await twilioRequest<{ messages: any[] }>(
    `${BASE}/2010-04-01/Accounts/${creds.sid}/Messages.json?PageSize=${limit}`,
    creds,
  );
  return data.messages;
}
