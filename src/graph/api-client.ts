import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

export class GraphApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GraphApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireGraphConfig(): { tenantId: string; clientId: string; clientSecret: string; senderEmail: string } {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET) {
    throw new GraphApiError({
      code: 'graph_not_configured',
      status: 0,
      message: 'Microsoft Graph credentials are not set (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET).',
      nextStep: 'Register an Azure AD app with Mail.Send permission and add credentials to the MCP server environment.',
    });
  }
  return {
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    senderEmail: env.GRAPH_SENDER_EMAIL || 'coo@otchealthmart.com',
  };
}

// ----- Token cache -----
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const config = requireGraphConfig();
  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  const { statusCode, body: respBody } = await request(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await respBody.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = {}; }

  if (statusCode !== 200 || !data.access_token) {
    throw new GraphApiError({
      code: 'graph_auth_failed',
      status: statusCode,
      message: `Failed to obtain Graph access token: ${data.error_description ?? data.error ?? 'unknown error'}`,
      nextStep: 'Verify GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and ensure Mail.Send permission is granted with admin consent.',
      upstream: data,
    });
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

// ----- Graph API request helper -----

async function graphRequest<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown },
): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const { statusCode, body: respBody } = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await respBody.text();

  // 202 Accepted (sendMail) or 204 No Content returns empty body
  if (statusCode === 202 || statusCode === 204) {
    return {} as T;
  }

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new GraphApiError({
      code: `graph_${data.error?.code ?? statusCode}`,
      status: statusCode,
      message: data.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Graph API error details.',
      upstream: data.error,
    });
  }
  return data as T;
}

// ----- Send Email (the headline tool for COO) -----

export interface SendEmailOpts {
  to: string | string[];
  subject: string;
  body: string;
  bodyType?: 'Text' | 'HTML';
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  saveToSentItems?: boolean;
}

export async function sendEmail(opts: SendEmailOpts): Promise<void> {
  const config = requireGraphConfig();
  const toRecipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).map(email => ({
    emailAddress: { address: email },
  }));

  const message: any = {
    subject: opts.subject,
    body: {
      contentType: opts.bodyType ?? 'Text',
      content: opts.body,
    },
    toRecipients,
  };

  if (opts.cc?.length) {
    message.ccRecipients = opts.cc.map(email => ({ emailAddress: { address: email } }));
  }
  if (opts.bcc?.length) {
    message.bccRecipients = opts.bcc.map(email => ({ emailAddress: { address: email } }));
  }
  if (opts.replyTo) {
    message.replyTo = [{ emailAddress: { address: opts.replyTo } }];
  }

  await graphRequest('POST', `/users/${config.senderEmail}/sendMail`, {
    body: {
      message,
      saveToSentItems: opts.saveToSentItems ?? true,
    },
  });
}

// ----- Read mailbox (for future use) -----

export async function listMessages(opts?: {
  folder?: string;
  top?: number;
  filter?: string;
}): Promise<any[]> {
  const config = requireGraphConfig();
  const folder = opts?.folder ?? 'inbox';
  let path = `/users/${config.senderEmail}/mailFolders/${folder}/messages`;
  const params = new URLSearchParams();
  if (opts?.top) params.set('$top', String(opts.top));
  if (opts?.filter) params.set('$filter', opts.filter);
  const qs = params.toString();
  if (qs) path += `?${qs}`;
  const resp = await graphRequest<{ value: any[] }>('GET', path);
  return resp.value ?? [];
}
