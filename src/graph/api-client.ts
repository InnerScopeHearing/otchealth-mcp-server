import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

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

/**
 * ALLOWLIST for every Graph mailbox tool (2026-07-25, CRO customer-service-engine handoff).
 *
 * WHY THIS EXISTS: the "Exec Fleet Microsoft Graph (INND)" app registration (GRAPH_CLIENT_ID) holds
 * broad, already-admin-consented application permissions -- Mail.ReadWrite, Mail.Send,
 * MailboxFolder.ReadWrite.All, MailboxSettings.ReadWrite, MailboxItem.ReadWrite.All -- which, as
 * APPLICATION (not delegated) permissions, let it act on ANY mailbox in the tenant by default,
 * including all ~50-60 legacy mailboxes never intended for this integration. Microsoft Graph itself
 * has NO mechanism to scope an application permission to a subset of mailboxes -- that requires an
 * Exchange Online ApplicationAccessPolicy (New-ApplicationAccessPolicy), an Exchange-Online-
 * PowerShell-only operation with no Graph REST equivalent, not yet provisioned as of this commit.
 * Until that policy exists, THIS allowlist is the only defense-in-depth boundary preventing an
 * over-broad `mailbox` argument from touching a legacy mailbox. Env-overridable
 * (GRAPH_CS_MAILBOXES, comma-separated) so new personas can be added without a redeploy; defaults
 * to the customer-service engine's 5 known addresses.
 */
function allowedMailboxes(): Set<string> {
  const csv = env.GRAPH_CS_MAILBOXES || 'care@otchealthmart.com,sarah@otchealthmart.com,helen@otchealthmart.com,ray@otchealthmart.com,coo@otchealthmart.com';
  return new Set(csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function assertAllowedMailbox(mailbox: string): void {
  if (!allowedMailboxes().has(mailbox.toLowerCase())) {
    throw new GraphApiError({
      code: 'mailbox_not_allowed',
      status: 0,
      message: `Mailbox "${mailbox}" is not on the allowlist for Graph mail tools (see GRAPH_CS_MAILBOXES). This is a code-level guard standing in for the ApplicationAccessPolicy that has not been provisioned yet -- it deliberately refuses to touch any mailbox outside the customer-service engine's known set.`,
      nextStep: 'If this mailbox should be reachable, add it to GRAPH_CS_MAILBOXES (and, once provisioned, the real Exchange ApplicationAccessPolicy).',
    });
  }
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

  // Token mint is a read-only OAuth exchange (no state mutation on Microsoft's side
  // beyond issuing a token): safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
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
  // GET is read-only (retries:1); this helper is also used for sendMail (POST), a
  // non-idempotent write, so every other method gets retries:0 to avoid a duplicate
  // send/mutation on a timeout.
  const retries = method === 'GET' ? 1 : 0;
  const res = await fetchWithBudget(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  }, { retries });
  const statusCode = res.status;
  const text = await res.text();

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

// ----- Send Email -----

export interface SendEmailOpts {
  to: string | string[];
  subject: string;
  body: string;
  bodyType?: 'Text' | 'HTML';
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  saveToSentItems?: boolean;
  /**
   * The customer-service persona mailbox to send AS (e.g. care@, sarah@, helen@, ray@, coo@).
   * Defaults to GRAPH_SENDER_EMAIL (coo@otchealthmart.com) for back-compat. Checked against
   * allowedMailboxes() -- see that function's header for why.
   */
  from?: string;
}

export async function sendEmail(opts: SendEmailOpts): Promise<void> {
  const config = requireGraphConfig();
  const sender = opts.from ?? config.senderEmail;
  assertAllowedMailbox(sender);
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

  await graphRequest('POST', `/users/${sender}/sendMail`, {
    body: {
      message,
      saveToSentItems: opts.saveToSentItems ?? true,
    },
  });
}

// ----- List mailbox messages -----

export async function listMessages(opts?: {
  mailbox?: string;
  folder?: string;
  top?: number;
  filter?: string;
  since?: string;
  unreadOnly?: boolean;
}): Promise<any[]> {
  const config = requireGraphConfig();
  const mailbox = opts?.mailbox ?? config.senderEmail;
  assertAllowedMailbox(mailbox);
  const folder = opts?.folder ?? 'inbox';
  let path = `/users/${mailbox}/mailFolders/${folder}/messages`;
  const params = new URLSearchParams();
  if (opts?.top) params.set('$top', String(opts.top));
  // Compose $filter from the explicit filter param plus since/unreadOnly convenience params,
  // joined with 'and' -- OData requires a single $filter expression, not multiple.
  const filterParts: string[] = [];
  if (opts?.filter) filterParts.push(opts.filter);
  if (opts?.since) filterParts.push(`receivedDateTime ge ${opts.since}`);
  if (opts?.unreadOnly) filterParts.push('isRead eq false');
  if (filterParts.length) params.set('$filter', filterParts.join(' and '));
  params.set('$orderby', 'receivedDateTime desc');
  const qs = params.toString();
  if (qs) path += `?${qs}`;
  const resp = await graphRequest<{ value: any[] }>('GET', path);
  return resp.value ?? [];
}

// ----- Get a single message (full body + attachment metadata) -----

export async function getMessage(mailbox: string, messageId: string): Promise<any> {
  assertAllowedMailbox(mailbox);
  const path = `/users/${mailbox}/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,body,hasAttachments`;
  const message = await graphRequest<any>('GET', path);
  if (message.hasAttachments) {
    const attResp = await graphRequest<{ value: any[] }>(
      'GET',
      `/users/${mailbox}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    message._attachments = attResp.value ?? [];
  }
  return message;
}

// ----- Mark a message read/unread -----

export async function markRead(mailbox: string, messageId: string, isRead: boolean): Promise<void> {
  assertAllowedMailbox(mailbox);
  await graphRequest('PATCH', `/users/${mailbox}/messages/${encodeURIComponent(messageId)}`, {
    body: { isRead },
  });
}
