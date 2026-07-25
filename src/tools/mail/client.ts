/**
 * MAIL ARCHIVE (Online Archive / In-Place Archive mailbox) — TEMPORARY, SHORT-LIVED gateway
 * service. Matt directive 2026-07-24: "give the CFO agent everything they need" to search,
 * read, and pull attachments from the "Online Archive" folder tree visible in Outlook desktop
 * (Archive / Deleted Items / DialPad / Drafts / Inbox / Sent Items under matthew@innd.com),
 * as a stopgap while the real email->PDF pipeline is designed.
 *
 * ===================== THIS IS TEMPORARY — DO NOT TREAT AS PERMANENT =====================
 * Microsoft Graph API CANNOT reach an in-place/Online Archive mailbox (dead end since 2020;
 * confirmed by research). The ONLY way in is Exchange Web Services (EWS) — which Microsoft is
 * RETIRING: phased disable starts 2026-10-01, full shutdown 2027-04-01, and In-Place Archive is
 * explicitly named as an affected capability. This module exists to unblock the CFO agent for
 * the next few days/weeks, NOT as the long-term design. Before Oct 2026 this must be replaced —
 * most likely by exporting/migrating the archive content into a store Graph (or a durable
 * non-EWS path) can reach. Flag this in every status update until it's replaced.
 *
 * ===================== AUTH =====================
 * App-only OAuth2 client_credentials against the "Office 365 Exchange Online" resource
 * (https://outlook.office365.com/.default), using the full_access_as_app application role
 * (granted 2026-07-24 on the existing otchealth-mail-readonly app registration — the app's
 * Graph permissions are separate and do NOT cover this; this is a distinct EWS-resource grant).
 * Confirmed working requirement, NOT optional even for full_access_as_app: EWS still requires an
 * <ExchangeImpersonation> SOAP header naming the target mailbox (ConnectingSID/PrimarySmtpAddress)
 * — omitting it fails with ErrorInvalidExchangeImpersonationHeaderData. X-AnchorMailbox routes the
 * HTTP request to the right backend. No refresh-token rotation complexity like Xero — client_credentials
 * mints a fresh app token each time; only the access token itself is cached in-memory (per replica).
 *
 * ===================== SCOPE =====================
 * Single hardcoded mailbox (MAIL_ARCHIVE_MAILBOX, default matthew@innd.com) — NOT a general
 * any-mailbox tool, even though full_access_as_app technically permits any mailbox in the tenant.
 * Read-only: FindFolder / FindItem / GetItem / GetAttachment. No send, no delete, no write.
 * XML PARSING NOTE: this is regex-based extraction over the known EWS response shape, not a real
 * XML parser — acceptable for a temporary bridge, NOT something to build further on.
 */
import { loadEnv } from '../../config/env.js';
import { EXEC_RING } from '../kb/search-privileged.js';

const FETCH_TIMEOUT_MS = 20000;
const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function isMailArchiveAllowed(caller: string | undefined | null): boolean {
  return Boolean(caller) && (EXEC_RING as readonly string[]).includes(caller as string);
}

export function mailRingRefusal(toolName: string, caller: string | undefined | null) {
  return {
    data: { error: 'forbidden_ring' },
    summary:
      `Refused: ${toolName} reads a personal/financial mailbox archive and requires an executive-ring ` +
      `lane (${EXEC_RING.join('/')}). Your identity: ${caller || '(none)'}. Never served to other lanes.`,
  };
}

export function mailArchiveConfigured(): boolean {
  const env = loadEnv() as unknown as Record<string, unknown>;
  return Boolean(env.MAIL_ARCHIVE_EWS_CLIENT_ID && env.MAIL_ARCHIVE_EWS_CLIENT_SECRET && env.MAIL_ARCHIVE_EWS_TENANT_ID);
}

function targetMailbox(): string {
  const env = loadEnv() as unknown as Record<string, unknown>;
  return String(env.MAIL_ARCHIVE_MAILBOX || 'matthew@innd.com');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- token cache (per-replica, no rotation needed — client_credentials mints a fresh token) ---
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  const env = loadEnv() as unknown as Record<string, unknown>;
  const clientId = String(env.MAIL_ARCHIVE_EWS_CLIENT_ID || '');
  const clientSecret = String(env.MAIL_ARCHIVE_EWS_CLIENT_SECRET || '');
  const tenantId = String(env.MAIL_ARCHIVE_EWS_TENANT_ID || '');
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('Mail archive not configured (MAIL_ARCHIVE_EWS_CLIENT_ID/SECRET/TENANT_ID missing)');
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://outlook.office365.com/.default',
  });
  const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Mail archive token request failed: HTTP ${r.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('Mail archive token request returned no access_token');
  cachedToken = { accessToken: j.access_token, expiresAt: Date.now() + Math.max(0, (j.expires_in ?? 3600) - 120) * 1000 };
  return j.access_token;
}

async function ewsCall(bodyXml: string): Promise<string> {
  const mailbox = targetMailbox();
  const accessToken = await getAccessToken();
  const soap =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ` +
    `xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">` +
    `<soap:Header><t:RequestServerVersion Version="Exchange2016" />` +
    `<t:ExchangeImpersonation><t:ConnectingSID><t:PrimarySmtpAddress>${esc(mailbox)}</t:PrimarySmtpAddress></t:ConnectingSID></t:ExchangeImpersonation>` +
    `</soap:Header><soap:Body>${bodyXml}</soap:Body></soap:Envelope>`;
  const r = await fetch(EWS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'text/xml; charset=utf-8',
      'X-AnchorMailbox': mailbox,
    },
    body: soap,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`EWS call failed: HTTP ${r.status} ${text.slice(0, 500)}`);
  if (/ResponseClass="Error"/.test(text)) {
    const msg = /<m:MessageText>([^<]*)<\/m:MessageText>/.exec(text)?.[1] ?? text.slice(0, 400);
    throw new Error(`EWS error response: ${msg}`);
  }
  return text;
}

// --- lightweight regex extraction helpers (see file header: not a real XML parser, temporary) ---
function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<t:${tag}[^>]*>([\\s\\S]*?)<\\/t:${tag}>`).exec(xml);
  return m ? m[1] : undefined;
}
function allBlocks(xml: string, openTag: string, closeTag: string): string[] {
  const re = new RegExp(`<${openTag}[^>]*>[\\s\\S]*?<${closeTag}>`, 'g');
  return xml.match(re) ?? [];
}

export interface ArchiveFolder {
  folderId: string;
  changeKey?: string;
  displayName: string;
  totalCount?: number;
  unreadCount?: number;
}

export async function ewsListArchiveFolders(): Promise<ArchiveFolder[]> {
  const body =
    `<m:FindFolder Traversal="Shallow"><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>` +
    `<m:ParentFolderIds><t:DistinguishedFolderId Id="archivemsgfolderroot" /></m:ParentFolderIds></m:FindFolder>`;
  const xml = await ewsCall(body);
  const folders: ArchiveFolder[] = [];
  for (const block of allBlocks(xml, 't:(?:Folder|CalendarFolder|ContactsFolder|SearchFolder|TasksFolder)', 't:\\/(?:Folder|CalendarFolder|ContactsFolder|SearchFolder|TasksFolder)>')) {
    const idTag = /<t:FolderId Id="([^"]*)" ChangeKey="([^"]*)"/.exec(block);
    const displayName = tagText(block, 'DisplayName');
    if (!idTag || !displayName) continue;
    folders.push({
      folderId: idTag[1],
      changeKey: idTag[2],
      displayName,
      totalCount: tagText(block, 'TotalCount') ? Number(tagText(block, 'TotalCount')) : undefined,
      unreadCount: tagText(block, 'UnreadCount') ? Number(tagText(block, 'UnreadCount')) : undefined,
    });
  }
  return folders;
}

export async function resolveArchiveFolderId(folderName: string): Promise<ArchiveFolder> {
  const folders = await ewsListArchiveFolders();
  const hit = folders.find((f) => f.displayName.toLowerCase() === folderName.toLowerCase());
  if (!hit) {
    throw new Error(
      `Folder "${folderName}" not found in the Online Archive. Available: ${folders.map((f) => f.displayName).join(', ')}`,
    );
  }
  return hit;
}

export interface ArchiveSearchHit {
  itemId: string;
  changeKey?: string;
  subject?: string;
  dateTimeReceived?: string;
  hasAttachments?: boolean;
  from?: string;
}

export async function ewsSearchItems(opts: {
  folderId: string;
  subjectContains?: string;
  from?: string; // ISO date, inclusive lower bound on DateTimeReceived
  to?: string; // ISO date, inclusive upper bound on DateTimeReceived
  maxResults?: number;
}): Promise<ArchiveSearchHit[]> {
  const clauses: string[] = [];
  if (opts.subjectContains) {
    clauses.push(
      `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="item:Subject" /><t:Constant Value="${esc(opts.subjectContains)}" /></t:Contains>`,
    );
  }
  if (opts.from) {
    clauses.push(`<t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${esc(opts.from)}" /></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo>`);
  }
  if (opts.to) {
    clauses.push(`<t:IsLessThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived" /><t:FieldURIOrConstant><t:Constant Value="${esc(opts.to)}" /></t:FieldURIOrConstant></t:IsLessThanOrEqualTo>`);
  }
  const restriction = clauses.length ? `<m:Restriction>${clauses.length > 1 ? `<t:And>${clauses.join('')}</t:And>` : clauses[0]}</m:Restriction>` : '';
  const max = Math.min(Math.max(1, opts.maxResults ?? 25), 100);
  const body =
    `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>Default</t:BaseShape>` +
    `<t:AdditionalProperties><t:FieldURI FieldURI="message:From" /><t:FieldURI FieldURI="item:HasAttachments" /></t:AdditionalProperties></m:ItemShape>` +
    `<m:IndexedPageItemView MaxEntriesReturned="${max}" Offset="0" BasePoint="Beginning" />` +
    `<m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived" /></t:FieldOrder></m:SortOrder>` +
    restriction +
    `<m:ParentFolderIds><t:FolderId Id="${esc(opts.folderId)}" /></m:ParentFolderIds></m:FindItem>`;
  const xml = await ewsCall(body);
  const hits: ArchiveSearchHit[] = [];
  for (const block of allBlocks(xml, 't:Message', 't:\\/Message>').concat(allBlocks(xml, 't:Item', 't:\\/Item>'))) {
    const idTag = /<t:ItemId Id="([^"]*)" ChangeKey="([^"]*)"/.exec(block);
    if (!idTag) continue;
    const fromMatch = /<t:Mailbox>[\s\S]*?<t:EmailAddress>([^<]*)<\/t:EmailAddress>/.exec(block);
    hits.push({
      itemId: idTag[1],
      changeKey: idTag[2],
      subject: tagText(block, 'Subject'),
      dateTimeReceived: tagText(block, 'DateTimeReceived'),
      hasAttachments: tagText(block, 'HasAttachments') === 'true',
      from: fromMatch?.[1],
    });
  }
  return hits;
}

export interface ArchiveAttachmentMeta {
  attachmentId: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

export interface ArchiveMessage {
  itemId: string;
  subject?: string;
  from?: string;
  toRecipients: string[];
  dateTimeReceived?: string;
  bodyText?: string;
  attachments: ArchiveAttachmentMeta[];
}

export async function ewsGetMessage(itemId: string): Promise<ArchiveMessage> {
  const body =
    `<m:GetItem><m:ItemShape><t:BaseShape>AllProperties</t:BaseShape><t:BodyType>Text</t:BodyType></m:ItemShape>` +
    `<m:ItemIds><t:ItemId Id="${esc(itemId)}" /></m:ItemIds></m:GetItem>`;
  const xml = await ewsCall(body);
  const fromMatch = /<t:From>[\s\S]*?<t:EmailAddress>([^<]*)<\/t:EmailAddress>/.exec(xml);
  const toBlock = /<t:ToRecipients>([\s\S]*?)<\/t:ToRecipients>/.exec(xml)?.[1] ?? '';
  const toRecipients = [...toBlock.matchAll(/<t:EmailAddress>([^<]*)<\/t:EmailAddress>/g)].map((m) => m[1]);
  const attachments: ArchiveAttachmentMeta[] = [];
  for (const block of allBlocks(xml, 't:(?:File|Item)Attachment', 't:\\/(?:File|Item)Attachment>')) {
    const idTag = /<t:AttachmentId Id="([^"]*)"/.exec(block);
    if (!idTag) continue;
    attachments.push({
      attachmentId: idTag[1],
      name: tagText(block, 'Name'),
      contentType: tagText(block, 'ContentType'),
      size: tagText(block, 'Size') ? Number(tagText(block, 'Size')) : undefined,
      isInline: tagText(block, 'IsInline') === 'true',
    });
  }
  return {
    itemId,
    subject: tagText(xml, 'Subject'),
    from: fromMatch?.[1],
    toRecipients,
    dateTimeReceived: tagText(xml, 'DateTimeReceived'),
    bodyText: tagText(xml, 'Body'),
    attachments,
  };
}

export interface ArchiveAttachmentContent {
  name?: string;
  contentType?: string;
  contentBase64: string;
  bytes: number;
}

export async function ewsGetAttachment(attachmentId: string): Promise<ArchiveAttachmentContent> {
  const body =
    `<m:GetAttachment><m:AttachmentShape><t:IncludeMimeContent>false</t:IncludeMimeContent></m:AttachmentShape>` +
    `<m:AttachmentIds><t:AttachmentId Id="${esc(attachmentId)}" /></m:AttachmentIds></m:GetAttachment>`;
  const xml = await ewsCall(body);
  const contentB64 = tagText(xml, 'Content');
  if (!contentB64) throw new Error('EWS GetAttachment returned no Content (may be an ItemAttachment, not a file)');
  const bytes = Buffer.from(contentB64, 'base64').length;
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment is ${bytes} bytes, exceeding this gateway's ${MAX_ATTACHMENT_BYTES}-byte cap.`);
  }
  return {
    name: tagText(xml, 'Name'),
    contentType: tagText(xml, 'ContentType'),
    contentBase64: contentB64,
    bytes,
  };
}
