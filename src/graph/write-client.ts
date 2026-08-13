/**
 * Microsoft Graph WRITE client — NEW file, app-only auth.
 * Auth pattern mirrors src/graph/api-client.ts exactly (same token cache,
 * same error class, same graphRequest helper). This file is self-contained so
 * the read client is never modified (hard rule).
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---- Error class (mirrors GraphApiError) ----

export class GraphWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GraphWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireGraphConfig(): { tenantId: string; clientId: string; clientSecret: string; senderEmail: string } {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET) {
    throw new GraphWriteError({
      code: 'graph_not_configured',
      status: 0,
      message: 'Microsoft Graph credentials are not set (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET).',
      nextStep: 'Register an Azure AD app with Mail.ReadWrite and Calendars.ReadWrite permissions and add credentials to the MCP server environment.',
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
 * ALLOWLIST for mailbox-scoped operations (2026-07-25, CRO customer-service-engine handoff).
 * Mirrors api-client.ts's allowedMailboxes()/assertAllowedMailbox() EXACTLY (duplicated, not
 * imported, to respect this file's own "self-contained" design note above). UPDATE (2026-07-26):
 * the real Exchange ApplicationAccessPolicy this allowlist was standing in for is now LIVE and
 * independently confirmed enforcing via Test-ApplicationAccessPolicy; this allowlist stays in
 * place as a fast defense-in-depth guard that runs before any Graph call is attempted.
 */
function allowedMailboxes(): Set<string> {
  const csv = env.GRAPH_CS_MAILBOXES || 'care@otchealthmart.com,sarah@otchealthmart.com,helen@otchealthmart.com,ray@otchealthmart.com,coo@otchealthmart.com';
  return new Set(csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function assertAllowedMailbox(mailbox: string): void {
  if (!allowedMailboxes().has(mailbox.toLowerCase())) {
    throw new GraphWriteError({
      code: 'mailbox_not_allowed',
      status: 0,
      message: `Mailbox "${mailbox}" is not on the allowlist for Graph mail tools (see GRAPH_CS_MAILBOXES). This is a fast code-level guard that runs in front of the real Exchange ApplicationAccessPolicy (live since 2026-07-26, confirmed enforcing via Test-ApplicationAccessPolicy).`,
      nextStep: 'If this mailbox should be reachable, add it to GRAPH_CS_MAILBOXES and to the CS-Engine-Mailboxes security group the real ApplicationAccessPolicy is scoped to.',
    });
  }
}

// ---- Token cache (separate from read client so each module is self-contained) ----

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
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

  // Token mint is a read-only OAuth exchange: safe to retry once on a network
  // blip / 429 / 5xx.
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
    throw new GraphWriteError({
      code: 'graph_auth_failed',
      status: statusCode,
      message: `Failed to obtain Graph access token: ${data.error_description ?? data.error ?? 'unknown error'}`,
      nextStep: 'Verify GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and ensure Mail.ReadWrite + Calendars.ReadWrite permissions have admin consent.',
      upstream: data,
    });
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

// ---- Graph request helper ----

async function graphRequest<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown },
): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;
  // Every caller of this write-client helper is a non-idempotent mutation (create
  // draft/event, reply, move, mark-read): retries:0 so a timeout never sends a
  // duplicate email, calendar invite, or mailbox mutation.
  const res = await fetchWithBudget(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();

  // 202 Accepted or 204 No Content return empty body
  if (statusCode === 202 || statusCode === 204) {
    return {} as T;
  }

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new GraphWriteError({
      code: `graph_${data.error?.code ?? statusCode}`,
      status: statusCode,
      message: data.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Graph API error details and ensure the app has the required delegated or application permissions.',
      upstream: data.error,
    });
  }
  return data as T;
}

// ---- getSenderEmail helper ----

function getSenderEmail(): string {
  return requireGraphConfig().senderEmail;
}

// ===========================================================================
// Write operations
// ===========================================================================

// ---- Draft email ----

export interface CreateDraftOpts {
  to: string | string[];
  subject: string;
  body: string;
  bodyType?: 'Text' | 'HTML';
  cc?: string[];
  bcc?: string[];
}

export interface DraftMessage {
  id: string;
  subject: string;
  webLink: string;
}

export async function createDraft(opts: CreateDraftOpts): Promise<DraftMessage> {
  const sender = getSenderEmail();
  const toRecipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).map(email => ({
    emailAddress: { address: email },
  }));

  const message: any = {
    subject: opts.subject,
    body: { contentType: opts.bodyType ?? 'Text', content: opts.body },
    toRecipients,
  };
  if (opts.cc?.length) {
    message.ccRecipients = opts.cc.map(email => ({ emailAddress: { address: email } }));
  }
  if (opts.bcc?.length) {
    message.bccRecipients = opts.bcc.map(email => ({ emailAddress: { address: email } }));
  }

  const resp = await graphRequest<any>('POST', `/users/${sender}/messages`, { body: message });
  return { id: resp.id ?? '', subject: resp.subject ?? '', webLink: resp.webLink ?? '' };
}

// ---- Reply to email ----

export interface ReplyEmailOpts {
  messageId: string;
  comment: string;
}

export async function replyEmail(opts: ReplyEmailOpts): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/messages/${opts.messageId}/reply`, {
    body: { comment: opts.comment },
  });
}

// ---- Move message ----

export interface MoveMessageOpts {
  messageId: string;
  /** Well-known folder name or folder ID. E.g. "deleteditems", "archive", "junkemail". */
  destinationId: string;
}

export interface MovedMessage {
  id: string;
  destinationId: string;
}

export async function moveMessage(opts: MoveMessageOpts): Promise<MovedMessage> {
  const sender = getSenderEmail();
  const resp = await graphRequest<any>('POST', `/users/${sender}/messages/${opts.messageId}/move`, {
    body: { destinationId: opts.destinationId },
  });
  return { id: resp.id ?? opts.messageId, destinationId: opts.destinationId };
}

// ---- Mark message read/unread ----

export interface MarkReadOpts {
  messageId: string;
  isRead: boolean;
  /**
   * Mailbox to operate on (2026-07-25, CRO customer-service-engine handoff). Defaults to
   * GRAPH_SENDER_EMAIL for back-compat with every existing caller. Checked against
   * assertAllowedMailbox() -- see that function's header for why.
   */
  mailbox?: string;
}

export async function markRead(opts: MarkReadOpts): Promise<void> {
  const sender = opts.mailbox ?? getSenderEmail();
  assertAllowedMailbox(sender);
  await graphRequest('PATCH', `/users/${sender}/messages/${opts.messageId}`, {
    body: { isRead: opts.isRead },
  });
}

// ---- Create calendar event ----

export interface Attendee {
  email: string;
  name?: string;
  type?: 'required' | 'optional' | 'resource';
}

export interface CreateCalendarEventOpts {
  subject: string;
  body?: string;
  bodyType?: 'Text' | 'HTML';
  /** ISO-8601 datetime string, e.g. "2026-07-01T09:00:00" */
  startDateTime: string;
  /** ISO-8601 datetime string */
  endDateTime: string;
  /** IANA timezone, e.g. "America/Chicago" */
  timeZone?: string;
  attendees?: Attendee[];
  location?: string;
  isOnlineMeeting?: boolean;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  webLink: string;
  onlineMeetingUrl: string | null;
}

export async function createCalendarEvent(opts: CreateCalendarEventOpts): Promise<CalendarEvent> {
  const sender = getSenderEmail();
  const tz = opts.timeZone ?? 'UTC';

  const eventBody: any = {
    subject: opts.subject,
    start: { dateTime: opts.startDateTime, timeZone: tz },
    end:   { dateTime: opts.endDateTime,   timeZone: tz },
  };

  if (opts.body) {
    eventBody.body = { contentType: opts.bodyType ?? 'Text', content: opts.body };
  }
  if (opts.location) {
    eventBody.location = { displayName: opts.location };
  }
  if (opts.attendees?.length) {
    eventBody.attendees = opts.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name ?? a.email },
      type: a.type ?? 'required',
    }));
  }
  if (opts.isOnlineMeeting !== undefined) {
    eventBody.isOnlineMeeting = opts.isOnlineMeeting;
    if (opts.isOnlineMeeting) {
      eventBody.onlineMeetingProvider = 'teamsForBusiness';
    }
  }

  const resp = await graphRequest<any>('POST', `/users/${sender}/events`, { body: eventBody });
  return {
    id: resp.id ?? '',
    subject: resp.subject ?? '',
    webLink: resp.webLink ?? '',
    onlineMeetingUrl: resp.onlineMeetingUrl ?? null,
  };
}
