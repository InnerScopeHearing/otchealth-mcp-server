/**
 * Microsoft Graph FULL client — exhaustive coverage (mail + calendar + contacts + users-read).
 * Self-contained: auth + request helper copied from api-client.ts. Does NOT touch api-client.ts
 * or write-client.ts. All operations scoped to /users/{GRAPH_SENDER_EMAIL}.
 * Scope: Mail.ReadWrite, Calendars.ReadWrite, Contacts.ReadWrite, User.Read.All (read-only users).
 * NO Teams, SharePoint, OneDrive, Intune, Directory-admin, or PHI.
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class GraphFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'GraphFullError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    this.upstream = args.upstream;
  }
}

function requireGraphConfig(): { tenantId: string; clientId: string; clientSecret: string; senderEmail: string } {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET) {
    throw new GraphFullError({
      code: 'graph_not_configured',
      status: 0,
      message: 'Microsoft Graph credentials are not set (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET).',
      nextStep: 'Register an Azure AD app with Mail.ReadWrite, Calendars.ReadWrite, Contacts.ReadWrite, User.Read.All permissions and add credentials to the MCP server environment.',
    });
  }
  return {
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    clientSecret: env.GRAPH_CLIENT_SECRET,
    senderEmail: env.GRAPH_SENDER_EMAIL || 'coo@otchealthmart.com',
  };
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

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
    throw new GraphFullError({
      code: 'graph_auth_failed',
      status: statusCode,
      message: `Failed to obtain Graph access token: ${data.error_description ?? data.error ?? 'unknown error'}`,
      nextStep: 'Verify GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and ensure all required permissions are granted with admin consent.',
      upstream: data,
    });
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function graphRequest<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown; queryParams?: Record<string, string> },
): Promise<T> {
  const token = await getAccessToken();
  let url = `https://graph.microsoft.com/v1.0${path}`;
  if (opts?.queryParams) {
    const qs = new URLSearchParams(opts.queryParams).toString();
    if (qs) url += `?${qs}`;
  }
  // GET is read-only (retries:1); every other verb here mutates mail/calendar/contacts
  // (send, forward, accept/decline, create/update/delete), so retries:0 to avoid a
  // duplicate send or mutation on a timeout.
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

  if (statusCode === 202 || statusCode === 204) {
    return {} as T;
  }

  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (statusCode >= 400) {
    throw new GraphFullError({
      code: `graph_${data.error?.code ?? statusCode}`,
      status: statusCode,
      message: data.error?.message ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Graph API error details and ensure the app has the required application permissions with admin consent.',
      upstream: data.error,
    });
  }
  return data as T;
}

function getSenderEmail(): string {
  return requireGraphConfig().senderEmail;
}

// ===========================================================================
// MAIL — Messages
// ===========================================================================

/** GET /users/{sender}/messages/{id} */
export async function getMessage(messageId: string): Promise<any> {
  const sender = getSenderEmail();
  return graphRequest<any>('GET', `/users/${sender}/messages/${messageId}`);
}

/** DELETE /users/{sender}/messages/{id} */
export async function deleteMessage(messageId: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('DELETE', `/users/${sender}/messages/${messageId}`);
}

/** POST /users/{sender}/messages/{id}/forward */
export interface ForwardMessageOpts {
  messageId: string;
  toRecipients: string[];
  comment?: string;
}
export async function forwardMessage(opts: ForwardMessageOpts): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/messages/${opts.messageId}/forward`, {
    body: {
      toRecipients: opts.toRecipients.map(e => ({ emailAddress: { address: e } })),
      comment: opts.comment ?? '',
    },
  });
}

/** PATCH /users/{sender}/messages/{id} — update categories, flag, subject, etc. */
export interface UpdateMessageOpts {
  messageId: string;
  categories?: string[];
  flag?: { flagStatus: 'notFlagged' | 'flagged' | 'complete' };
  isRead?: boolean;
}
export async function updateMessage(opts: UpdateMessageOpts): Promise<any> {
  const sender = getSenderEmail();
  const patch: any = {};
  if (opts.categories !== undefined) patch.categories = opts.categories;
  if (opts.flag !== undefined) patch.flag = opts.flag;
  if (opts.isRead !== undefined) patch.isRead = opts.isRead;
  return graphRequest<any>('PATCH', `/users/${sender}/messages/${opts.messageId}`, { body: patch });
}

/** POST /users/{sender}/messages/{id}/replyAll */
export interface ReplyAllOpts {
  messageId: string;
  comment: string;
}
export async function replyAll(opts: ReplyAllOpts): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/messages/${opts.messageId}/replyAll`, {
    body: { comment: opts.comment },
  });
}

/** POST /users/{sender}/messages/{id}/send  — send an existing draft */
export async function sendDraft(messageId: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/messages/${messageId}/send`);
}

// ===========================================================================
// MAIL — Folders
// ===========================================================================

/** GET /users/{sender}/mailFolders */
export async function listMailFolders(includeHidden?: boolean): Promise<any[]> {
  const sender = getSenderEmail();
  const qp: Record<string, string> = { $top: '50' };
  if (includeHidden) qp.includeHiddenFolders = 'true';
  const resp = await graphRequest<{ value: any[] }>('GET', `/users/${sender}/mailFolders`, { queryParams: qp });
  return resp.value ?? [];
}

/** POST /users/{sender}/mailFolders */
export interface CreateMailFolderOpts {
  displayName: string;
  isHidden?: boolean;
  parentFolderId?: string;
}
export async function createMailFolder(opts: CreateMailFolderOpts): Promise<any> {
  const sender = getSenderEmail();
  const basePath = opts.parentFolderId
    ? `/users/${sender}/mailFolders/${opts.parentFolderId}/childFolders`
    : `/users/${sender}/mailFolders`;
  const body: any = { displayName: opts.displayName };
  if (opts.isHidden !== undefined) body.isHidden = opts.isHidden;
  return graphRequest<any>('POST', basePath, { body });
}

/** GET /users/{sender}/mailFolders/{folderId}/messages */
export async function listFolderMessages(opts: {
  folderId: string;
  top?: number;
  filter?: string;
  select?: string;
}): Promise<any[]> {
  const sender = getSenderEmail();
  const qp: Record<string, string> = {};
  if (opts.top) qp['$top'] = String(opts.top);
  if (opts.filter) qp['$filter'] = opts.filter;
  if (opts.select) qp['$select'] = opts.select;
  const resp = await graphRequest<{ value: any[] }>(
    'GET',
    `/users/${sender}/mailFolders/${opts.folderId}/messages`,
    { queryParams: qp },
  );
  return resp.value ?? [];
}

// ===========================================================================
// MAIL — Attachments
// ===========================================================================

/** GET /users/{sender}/messages/{id}/attachments */
export async function listAttachments(messageId: string): Promise<any[]> {
  const sender = getSenderEmail();
  const resp = await graphRequest<{ value: any[] }>(
    'GET',
    `/users/${sender}/messages/${messageId}/attachments`,
  );
  return resp.value ?? [];
}

/** GET /users/{sender}/messages/{id}/attachments/{attachmentId} */
export async function getAttachment(messageId: string, attachmentId: string): Promise<any> {
  const sender = getSenderEmail();
  return graphRequest<any>('GET', `/users/${sender}/messages/${messageId}/attachments/${attachmentId}`);
}

/** POST /users/{sender}/messages/{id}/attachments — base64 file attachment */
export interface AddAttachmentOpts {
  messageId: string;
  name: string;
  /** base64-encoded content */
  contentBytes: string;
  contentType: string;
}
export async function addAttachment(opts: AddAttachmentOpts): Promise<any> {
  const sender = getSenderEmail();
  return graphRequest<any>('POST', `/users/${sender}/messages/${opts.messageId}/attachments`, {
    body: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: opts.name,
      contentBytes: opts.contentBytes,
      contentType: opts.contentType,
    },
  });
}

// ===========================================================================
// CALENDAR — Events
// ===========================================================================

/** GET /users/{sender}/events */
export async function listEvents(opts?: {
  top?: number;
  filter?: string;
  select?: string;
  calendarId?: string;
}): Promise<any[]> {
  const sender = getSenderEmail();
  const basePath = opts?.calendarId
    ? `/users/${sender}/calendars/${opts.calendarId}/events`
    : `/users/${sender}/events`;
  const qp: Record<string, string> = {};
  if (opts?.top) qp['$top'] = String(opts.top);
  if (opts?.filter) qp['$filter'] = opts.filter;
  if (opts?.select) qp['$select'] = opts.select;
  const resp = await graphRequest<{ value: any[] }>('GET', basePath, { queryParams: qp });
  return resp.value ?? [];
}

/** GET /users/{sender}/events/{id} */
export async function getEvent(eventId: string): Promise<any> {
  const sender = getSenderEmail();
  return graphRequest<any>('GET', `/users/${sender}/events/${eventId}`);
}

/** PATCH /users/{sender}/events/{id} */
export interface UpdateEventOpts {
  eventId: string;
  subject?: string;
  body?: string;
  bodyType?: 'Text' | 'HTML';
  startDateTime?: string;
  endDateTime?: string;
  timeZone?: string;
  location?: string;
  attendees?: Array<{ email: string; name?: string; type?: 'required' | 'optional' | 'resource' }>;
  isOnlineMeeting?: boolean;
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';
}
export async function updateEvent(opts: UpdateEventOpts): Promise<any> {
  const sender = getSenderEmail();
  const patch: any = {};
  if (opts.subject !== undefined) patch.subject = opts.subject;
  if (opts.body !== undefined) {
    patch.body = { contentType: opts.bodyType ?? 'Text', content: opts.body };
  }
  const tz = opts.timeZone ?? 'UTC';
  if (opts.startDateTime !== undefined) patch.start = { dateTime: opts.startDateTime, timeZone: tz };
  if (opts.endDateTime !== undefined) patch.end = { dateTime: opts.endDateTime, timeZone: tz };
  if (opts.location !== undefined) patch.location = { displayName: opts.location };
  if (opts.attendees !== undefined) {
    patch.attendees = opts.attendees.map(a => ({
      emailAddress: { address: a.email, name: a.name ?? a.email },
      type: a.type ?? 'required',
    }));
  }
  if (opts.isOnlineMeeting !== undefined) patch.isOnlineMeeting = opts.isOnlineMeeting;
  if (opts.showAs !== undefined) patch.showAs = opts.showAs;
  return graphRequest<any>('PATCH', `/users/${sender}/events/${opts.eventId}`, { body: patch });
}

/** DELETE /users/{sender}/events/{id} */
export async function deleteEvent(eventId: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('DELETE', `/users/${sender}/events/${eventId}`);
}

/** POST /users/{sender}/events/{id}/accept */
export async function acceptEvent(eventId: string, comment?: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/events/${eventId}/accept`, {
    body: { comment: comment ?? '', sendResponse: true },
  });
}

/** POST /users/{sender}/events/{id}/decline */
export async function declineEvent(eventId: string, comment?: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/events/${eventId}/decline`, {
    body: { comment: comment ?? '', sendResponse: true },
  });
}

/** POST /users/{sender}/events/{id}/tentativelyAccept */
export async function tentativelyAcceptEvent(eventId: string, comment?: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('POST', `/users/${sender}/events/${eventId}/tentativelyAccept`, {
    body: { comment: comment ?? '', sendResponse: true },
  });
}

/** GET /users/{sender}/calendars */
export async function listCalendars(): Promise<any[]> {
  const sender = getSenderEmail();
  const resp = await graphRequest<{ value: any[] }>('GET', `/users/${sender}/calendars`);
  return resp.value ?? [];
}

/** POST /users/{sender}/calendar/getSchedule — find-meeting-times via free/busy */
export interface FindMeetingTimesOpts {
  attendeeEmails: string[];
  startDateTime: string;
  endDateTime: string;
  timeZone?: string;
  meetingDurationMinutes?: number;
}
export async function findMeetingTimes(opts: FindMeetingTimesOpts): Promise<any> {
  const sender = getSenderEmail();
  const tz = opts.timeZone ?? 'UTC';
  return graphRequest<any>('POST', `/users/${sender}/calendar/getSchedule`, {
    body: {
      schedules: opts.attendeeEmails,
      startTime: { dateTime: opts.startDateTime, timeZone: tz },
      endTime: { dateTime: opts.endDateTime, timeZone: tz },
      availabilityViewInterval: opts.meetingDurationMinutes ?? 30,
    },
  });
}

/** GET /users/{sender}/events/{id}/instances — recurring event instances */
export async function listEventInstances(opts: {
  eventId: string;
  startDateTime: string;
  endDateTime: string;
  top?: number;
}): Promise<any[]> {
  const sender = getSenderEmail();
  const qp: Record<string, string> = {
    startDateTime: opts.startDateTime,
    endDateTime: opts.endDateTime,
  };
  if (opts.top) qp['$top'] = String(opts.top);
  const resp = await graphRequest<{ value: any[] }>(
    'GET',
    `/users/${sender}/events/${opts.eventId}/instances`,
    { queryParams: qp },
  );
  return resp.value ?? [];
}

// ===========================================================================
// CONTACTS
// ===========================================================================

/** GET /users/{sender}/contacts */
export async function listContacts(opts?: { top?: number; filter?: string; select?: string }): Promise<any[]> {
  const sender = getSenderEmail();
  const qp: Record<string, string> = {};
  if (opts?.top) qp['$top'] = String(opts.top);
  if (opts?.filter) qp['$filter'] = opts.filter;
  if (opts?.select) qp['$select'] = opts.select;
  const resp = await graphRequest<{ value: any[] }>('GET', `/users/${sender}/contacts`, { queryParams: qp });
  return resp.value ?? [];
}

/** GET /users/{sender}/contacts/{id} */
export async function getContact(contactId: string): Promise<any> {
  const sender = getSenderEmail();
  return graphRequest<any>('GET', `/users/${sender}/contacts/${contactId}`);
}

/** POST /users/{sender}/contacts */
export interface CreateContactOpts {
  givenName: string;
  surname?: string;
  emailAddresses?: Array<{ address: string; name?: string }>;
  mobilePhone?: string;
  businessPhones?: string[];
  jobTitle?: string;
  companyName?: string;
  department?: string;
  officeLocation?: string;
  personalNotes?: string;
}
export async function createContact(opts: CreateContactOpts): Promise<any> {
  const sender = getSenderEmail();
  const body: any = { givenName: opts.givenName };
  if (opts.surname !== undefined) body.surname = opts.surname;
  if (opts.emailAddresses?.length) {
    body.emailAddresses = opts.emailAddresses.map(e => ({
      address: e.address,
      name: e.name ?? e.address,
    }));
  }
  if (opts.mobilePhone !== undefined) body.mobilePhone = opts.mobilePhone;
  if (opts.businessPhones?.length) body.businessPhones = opts.businessPhones;
  if (opts.jobTitle !== undefined) body.jobTitle = opts.jobTitle;
  if (opts.companyName !== undefined) body.companyName = opts.companyName;
  if (opts.department !== undefined) body.department = opts.department;
  if (opts.officeLocation !== undefined) body.officeLocation = opts.officeLocation;
  if (opts.personalNotes !== undefined) body.personalNotes = opts.personalNotes;
  return graphRequest<any>('POST', `/users/${sender}/contacts`, { body });
}

/** PATCH /users/{sender}/contacts/{id} */
export interface UpdateContactOpts {
  contactId: string;
  givenName?: string;
  surname?: string;
  emailAddresses?: Array<{ address: string; name?: string }>;
  mobilePhone?: string;
  businessPhones?: string[];
  jobTitle?: string;
  companyName?: string;
  department?: string;
  officeLocation?: string;
  personalNotes?: string;
}
export async function updateContact(opts: UpdateContactOpts): Promise<any> {
  const sender = getSenderEmail();
  const patch: any = {};
  if (opts.givenName !== undefined) patch.givenName = opts.givenName;
  if (opts.surname !== undefined) patch.surname = opts.surname;
  if (opts.emailAddresses !== undefined) {
    patch.emailAddresses = opts.emailAddresses.map(e => ({ address: e.address, name: e.name ?? e.address }));
  }
  if (opts.mobilePhone !== undefined) patch.mobilePhone = opts.mobilePhone;
  if (opts.businessPhones !== undefined) patch.businessPhones = opts.businessPhones;
  if (opts.jobTitle !== undefined) patch.jobTitle = opts.jobTitle;
  if (opts.companyName !== undefined) patch.companyName = opts.companyName;
  if (opts.department !== undefined) patch.department = opts.department;
  if (opts.officeLocation !== undefined) patch.officeLocation = opts.officeLocation;
  if (opts.personalNotes !== undefined) patch.personalNotes = opts.personalNotes;
  return graphRequest<any>('PATCH', `/users/${sender}/contacts/${opts.contactId}`, { body: patch });
}

/** DELETE /users/{sender}/contacts/{id} */
export async function deleteContact(contactId: string): Promise<void> {
  const sender = getSenderEmail();
  await graphRequest('DELETE', `/users/${sender}/contacts/${contactId}`);
}

// ===========================================================================
// USERS — read-only, basic profile
// ===========================================================================

/** GET /users/{userId} — basic profile fields only (no PHI, no directory-admin data) */
export async function getUser(userId: string): Promise<any> {
  return graphRequest<any>('GET', `/users/${userId}`, {
    queryParams: { $select: 'id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,mobilePhone' },
  });
}

/** GET /users — list users, basic profile only */
export async function listUsers(opts?: { top?: number; filter?: string; search?: string }): Promise<any[]> {
  const qp: Record<string, string> = {
    $select: 'id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation',
  };
  if (opts?.top) qp['$top'] = String(opts.top);
  if (opts?.filter) qp['$filter'] = opts.filter;
  // $search requires ConsistencyLevel: eventual header — handled in a special path
  const resp = await graphRequest<{ value: any[] }>('GET', '/users', { queryParams: qp });
  return resp.value ?? [];
}
