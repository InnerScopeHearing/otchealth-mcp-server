/**
 * Intercom FULL client — exhaustive coverage of the Intercom REST API v2.11.
 * Self-contained: auth + request helper copied from src/intercom/client.ts.
 * Do NOT import from write-client.ts or client.ts — this file is standalone.
 * Base URL: https://api.intercom.io
 * Auth: Bearer token + Intercom-Version header.
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const BASE = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.11';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class IntercomFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'IntercomFullError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireToken(): string {
  if (!env.INTERCOM_ACCESS_TOKEN) {
    throw new IntercomFullError({
      code: 'intercom_not_configured',
      status: 0,
      message: 'Intercom integration is not configured.',
      nextStep: "Set INTERCOM_ACCESS_TOKEN in Railway env vars. Value is in Matt's Notion Token Vault under Intercom section.",
    });
  }
  return env.INTERCOM_ACCESS_TOKEN;
}

function mapError(status: number, path: string, body: string): IntercomFullError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep raw */ }
  if (status === 401 || status === 403) {
    return new IntercomFullError({
      code: 'intercom_auth_failed',
      status,
      message: `Intercom rejected auth on ${path}.`,
      nextStep: 'Confirm INTERCOM_ACCESS_TOKEN in Railway matches the Notion vault value.',
      upstream,
    });
  }
  if (status === 404) {
    return new IntercomFullError({
      code: 'intercom_not_found',
      status,
      message: `Intercom returned 404 for ${path}.`,
      nextStep: 'Verify the resource ID. Use list tools to find valid IDs.',
      upstream,
    });
  }
  if (status === 422) {
    return new IntercomFullError({
      code: 'intercom_validation_error',
      status,
      message: `Intercom returned 422 (validation error) for ${path}.`,
      nextStep: 'Check required fields and value constraints against Intercom API docs.',
      upstream,
    });
  }
  if (status === 429) {
    return new IntercomFullError({
      code: 'intercom_rate_limited',
      status,
      message: 'Intercom rate-limited the call.',
      nextStep: 'Back off and retry after a few seconds.',
      upstream,
    });
  }
  return new IntercomFullError({
    code: status >= 500 ? 'intercom_upstream_error' : 'intercom_request_error',
    status,
    message: `Intercom returned ${status} for ${path}.`,
    nextStep: status >= 500 ? 'Check https://www.intercomstatus.com/ and retry.' : 'Verify input parameters against Intercom API docs.',
    upstream,
  });
}

function buildQuery(q?: Record<string, string | number | boolean | undefined>): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function iGet<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const token = requireToken();
  const url = `${BASE}${path}${buildQuery(query)}`;
  const res = await request(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'intercom-version': INTERCOM_VERSION,
    },
  });
  const text = await res.body.text();
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
  throw mapError(res.statusCode, path, text);
}

async function iWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = requireToken();
  const url = `${BASE}${path}`;
  const res = await request(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'intercom-version': INTERCOM_VERSION,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.body.text();
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
  throw mapError(res.statusCode, path, text);
}

// ===========================================================================
// CONTACTS
// ===========================================================================

export interface ListContactsOpts {
  per_page?: number;
  starting_after?: string;
  /** Email filter */
  email?: string;
}

export async function fcListContacts(opts: ListContactsOpts = {}): Promise<any> {
  return iGet('/contacts', {
    per_page: opts.per_page,
    starting_after: opts.starting_after,
    email: opts.email,
  });
}

export async function fcGetContact(contact_id: string): Promise<any> {
  return iGet(`/contacts/${contact_id}`);
}

export interface UpdateContactOpts {
  contact_id: string;
  email?: string;
  name?: string;
  phone?: string;
  external_id?: string;
  custom_attributes?: Record<string, unknown>;
  avatar?: string;
  unsubscribed_from_emails?: boolean;
}

export async function fcUpdateContact(opts: UpdateContactOpts): Promise<any> {
  const { contact_id, ...payload } = opts;
  return iWrite('PUT', `/contacts/${contact_id}`, payload);
}

export async function fcDeleteContact(contact_id: string): Promise<any> {
  return iWrite('DELETE', `/contacts/${contact_id}`);
}

export interface SearchContactsOpts {
  query: {
    field: string;
    operator: string;
    value: string | number | boolean;
  } | {
    operator: 'AND' | 'OR';
    value: Array<{ field: string; operator: string; value: string | number | boolean }>;
  };
  per_page?: number;
  starting_after?: string;
}

export async function fcSearchContacts(opts: SearchContactsOpts): Promise<any> {
  const payload: Record<string, unknown> = { query: opts.query };
  if (opts.per_page || opts.starting_after) {
    payload.pagination = { per_page: opts.per_page, starting_after: opts.starting_after };
  }
  return iWrite('POST', '/contacts/search', payload);
}

export async function fcArchiveContact(contact_id: string): Promise<any> {
  return iWrite('POST', `/contacts/${contact_id}/archive`);
}

export async function fcUnarchiveContact(contact_id: string): Promise<any> {
  return iWrite('POST', `/contacts/${contact_id}/unarchive`);
}

export async function fcListContactAttachedCompanies(contact_id: string): Promise<any> {
  return iGet(`/contacts/${contact_id}/companies`);
}

export async function fcListContactAttachedTags(contact_id: string): Promise<any> {
  return iGet(`/contacts/${contact_id}/tags`);
}

// ===========================================================================
// CONVERSATIONS
// ===========================================================================

export interface ListConversationsOpts {
  per_page?: number;
  starting_after?: string;
  /** open | closed | snoozed */
  state?: string;
  /** Filter by admin (assignee) id */
  assignee_id?: string;
}

export async function fcListConversations(opts: ListConversationsOpts = {}): Promise<any> {
  return iGet('/conversations', {
    per_page: opts.per_page,
    starting_after: opts.starting_after,
    state: opts.state,
    assignee_id: opts.assignee_id,
  });
}

export async function fcGetConversation(conversation_id: string): Promise<any> {
  return iGet(`/conversations/${conversation_id}`);
}

export interface SearchConversationsOpts {
  query: {
    field: string;
    operator: string;
    value: string | number | boolean;
  } | {
    operator: 'AND' | 'OR';
    value: Array<{ field: string; operator: string; value: string | number | boolean }>;
  };
  per_page?: number;
  starting_after?: string;
}

export async function fcSearchConversations(opts: SearchConversationsOpts): Promise<any> {
  const payload: Record<string, unknown> = { query: opts.query };
  if (opts.per_page || opts.starting_after) {
    payload.pagination = { per_page: opts.per_page, starting_after: opts.starting_after };
  }
  return iWrite('POST', '/conversations/search', payload);
}

export interface AssignConversationOpts {
  conversation_id: string;
  /** admin_id to assign to */
  assignee_id: string;
  /** team_id to assign to (optional) */
  team_id?: string;
  /** The admin making the assignment (must be an admin id) */
  admin_id: string;
}

export async function fcAssignConversation(opts: AssignConversationOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/parts`, {
    message_type: 'assignment',
    type: 'admin',
    admin_id: opts.admin_id,
    assignee_id: opts.assignee_id,
    ...(opts.team_id ? { team_id: opts.team_id } : {}),
  });
}

export interface CloseConversationOpts {
  conversation_id: string;
  admin_id: string;
}

export async function fcCloseConversation(opts: CloseConversationOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/parts`, {
    message_type: 'close',
    type: 'admin',
    admin_id: opts.admin_id,
  });
}

export interface SnoozeConversationOpts {
  conversation_id: string;
  admin_id: string;
  /** Unix timestamp (seconds) when to wake up */
  snoozed_until: number;
}

export async function fcSnoozeConversation(opts: SnoozeConversationOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/parts`, {
    message_type: 'snoozed',
    type: 'admin',
    admin_id: opts.admin_id,
    snoozed_until: opts.snoozed_until,
  });
}

export interface OpenConversationOpts {
  conversation_id: string;
  admin_id: string;
}

export async function fcOpenConversation(opts: OpenConversationOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/parts`, {
    message_type: 'open',
    type: 'admin',
    admin_id: opts.admin_id,
  });
}

export interface AttachTagToConversationOpts {
  conversation_id: string;
  tag_id: string;
  admin_id: string;
}

export async function fcAttachTagToConversation(opts: AttachTagToConversationOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/tags`, {
    id: opts.tag_id,
    admin_id: opts.admin_id,
  });
}

export interface DetachTagFromConversationOpts {
  conversation_id: string;
  tag_id: string;
  admin_id: string;
}

export async function fcDetachTagFromConversation(opts: DetachTagFromConversationOpts): Promise<any> {
  return iWrite('DELETE', `/conversations/${opts.conversation_id}/tags/${opts.tag_id}`, {
    admin_id: opts.admin_id,
  });
}

export interface RunAssignmentRulesOpts {
  conversation_id: string;
}

export async function fcRunAssignmentRules(opts: RunAssignmentRulesOpts): Promise<any> {
  return iWrite('POST', `/conversations/${opts.conversation_id}/run_assignment_rules`);
}

// ===========================================================================
// COMPANIES
// ===========================================================================

export interface ListCompaniesOpts {
  per_page?: number;
  page?: number;
  order?: 'asc' | 'desc';
  sort?: string;
}

export async function fcListCompanies(opts: ListCompaniesOpts = {}): Promise<any> {
  return iGet('/companies', {
    per_page: opts.per_page,
    page: opts.page,
    order: opts.order,
    sort: opts.sort,
  });
}

export async function fcGetCompany(company_id: string): Promise<any> {
  return iGet(`/companies/${company_id}`);
}

export interface CreateCompanyOpts {
  company_id?: string;
  name?: string;
  plan?: string;
  monthly_spend?: number;
  size?: number;
  website?: string;
  industry?: string;
  custom_attributes?: Record<string, unknown>;
}

export async function fcCreateCompany(opts: CreateCompanyOpts): Promise<any> {
  return iWrite('POST', '/companies', opts);
}

export interface UpdateCompanyOpts {
  company_id_param: string;
  name?: string;
  plan?: string;
  monthly_spend?: number;
  size?: number;
  website?: string;
  industry?: string;
  custom_attributes?: Record<string, unknown>;
}

export async function fcUpdateCompany(opts: UpdateCompanyOpts): Promise<any> {
  const { company_id_param, ...payload } = opts;
  return iWrite('PUT', `/companies/${company_id_param}`, payload);
}

export async function fcDeleteCompany(company_id: string): Promise<any> {
  return iWrite('DELETE', `/companies/${company_id}`);
}

export interface ListCompanyContactsOpts {
  company_id: string;
  per_page?: number;
  starting_after?: string;
}

export async function fcListCompanyAttachedContacts(opts: ListCompanyContactsOpts): Promise<any> {
  return iGet(`/companies/${opts.company_id}/contacts`, {
    per_page: opts.per_page,
    starting_after: opts.starting_after,
  });
}

export interface AttachContactToCompanyOpts {
  company_id: string;
  contact_id: string;
}

export async function fcAttachContactToCompany(opts: AttachContactToCompanyOpts): Promise<any> {
  return iWrite('POST', `/contacts/${opts.contact_id}/companies`, { id: opts.company_id });
}

export interface DetachContactFromCompanyOpts {
  company_id: string;
  contact_id: string;
}

export async function fcDetachContactFromCompany(opts: DetachContactFromCompanyOpts): Promise<any> {
  return iWrite('DELETE', `/contacts/${opts.contact_id}/companies/${opts.company_id}`);
}

// ===========================================================================
// ARTICLES
// ===========================================================================

export async function fcDeleteArticle(article_id: string): Promise<any> {
  return iWrite('DELETE', `/articles/${article_id}`);
}

export interface SearchArticlesOpts {
  phrase: string;
  /** highlight results (default: true) */
  highlight?: boolean;
  /** state filter: published | draft */
  state?: 'published' | 'draft';
}

export async function fcSearchArticles(opts: SearchArticlesOpts): Promise<any> {
  return iGet('/articles', { phrase: opts.phrase, state: opts.state });
}

// ===========================================================================
// COLLECTIONS (Help Center)
// ===========================================================================

export async function fcListCollections(): Promise<any> {
  return iGet('/help_center/collections');
}

export async function fcGetCollection(collection_id: string): Promise<any> {
  return iGet(`/help_center/collections/${collection_id}`);
}

export interface CreateCollectionOpts {
  name: string;
  description?: string;
  /** Intercom admin id who authors this collection */
  translated_content?: { type?: 'group_translated_content'; [locale: string]: any };
}

export async function fcCreateCollection(opts: CreateCollectionOpts): Promise<any> {
  return iWrite('POST', '/help_center/collections', opts);
}

export interface UpdateCollectionOpts {
  collection_id: string;
  name?: string;
  description?: string;
  translated_content?: Record<string, unknown>;
}

export async function fcUpdateCollection(opts: UpdateCollectionOpts): Promise<any> {
  const { collection_id, ...payload } = opts;
  return iWrite('PUT', `/help_center/collections/${collection_id}`, payload);
}

export async function fcDeleteCollection(collection_id: string): Promise<any> {
  return iWrite('DELETE', `/help_center/collections/${collection_id}`);
}

// ===========================================================================
// TAGS
// ===========================================================================

export async function fcListTags(): Promise<any> {
  return iGet('/tags');
}

export interface CreateTagOpts {
  name: string;
}

export async function fcCreateTag(opts: CreateTagOpts): Promise<any> {
  return iWrite('POST', '/tags', { name: opts.name });
}

export interface UpdateTagOpts {
  tag_id: string;
  name: string;
}

export async function fcUpdateTag(opts: UpdateTagOpts): Promise<any> {
  return iWrite('POST', '/tags', { id: opts.tag_id, name: opts.name });
}

export async function fcDeleteTag(tag_id: string): Promise<any> {
  return iWrite('DELETE', `/tags/${tag_id}`);
}

/** Tag a contact */
export interface TagContactOpts {
  tag_id: string;
  contact_id: string;
}

export async function fcTagContact(opts: TagContactOpts): Promise<any> {
  return iWrite('POST', `/contacts/${opts.contact_id}/tags`, { id: opts.tag_id });
}

/** Untag a contact */
export interface UntagContactOpts {
  tag_id: string;
  contact_id: string;
}

export async function fcUntagContact(opts: UntagContactOpts): Promise<any> {
  return iWrite('DELETE', `/contacts/${opts.contact_id}/tags/${opts.tag_id}`);
}

/** Tag a company */
export interface TagCompanyOpts {
  tag_id: string;
  company_id: string;
}

export async function fcTagCompany(opts: TagCompanyOpts): Promise<any> {
  return iWrite('POST', '/tags', { id: opts.tag_id, companies: [{ id: opts.company_id }] });
}

/** Untag a company */
export interface UntagCompanyOpts {
  tag_id: string;
  company_id: string;
}

export async function fcUntagCompany(opts: UntagCompanyOpts): Promise<any> {
  return iWrite('POST', '/tags', { id: opts.tag_id, companies: [{ id: opts.company_id, untag: true }] });
}

// ===========================================================================
// NOTES
// ===========================================================================

export async function fcListContactNotes(contact_id: string): Promise<any> {
  return iGet(`/contacts/${contact_id}/notes`);
}

export async function fcGetNote(note_id: string): Promise<any> {
  return iGet(`/notes/${note_id}`);
}

// ===========================================================================
// SEGMENTS
// ===========================================================================

export async function fcListSegments(): Promise<any> {
  return iGet('/segments');
}

export async function fcGetSegment(segment_id: string): Promise<any> {
  return iGet(`/segments/${segment_id}`);
}

// ===========================================================================
// DATA ATTRIBUTES
// ===========================================================================

export interface ListDataAttributesOpts {
  model?: 'contact' | 'company' | 'conversation';
  include_archived?: boolean;
}

export async function fcListDataAttributes(opts: ListDataAttributesOpts = {}): Promise<any> {
  return iGet('/data_attributes', {
    model: opts.model,
    include_archived: opts.include_archived,
  });
}

export interface CreateDataAttributeOpts {
  name: string;
  model: 'contact' | 'company';
  data_type: 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'list';
  description?: string;
  options?: Array<{ value: string }>;
}

export async function fcCreateDataAttribute(opts: CreateDataAttributeOpts): Promise<any> {
  return iWrite('POST', '/data_attributes', opts);
}

export interface UpdateDataAttributeOpts {
  attribute_id: number;
  archived?: boolean;
  description?: string;
  options?: Array<{ value: string }>;
}

export async function fcUpdateDataAttribute(opts: UpdateDataAttributeOpts): Promise<any> {
  const { attribute_id, ...payload } = opts;
  return iWrite('PUT', `/data_attributes/${attribute_id}`, payload);
}

// ===========================================================================
// ADMINS
// ===========================================================================

export async function fcListAdmins(): Promise<any> {
  return iGet('/admins');
}

export async function fcGetAdmin(admin_id: string): Promise<any> {
  return iGet(`/admins/${admin_id}`);
}

export interface SetAdminAwayOpts {
  admin_id: string;
  away_mode_enabled: boolean;
  away_mode_reassign: boolean;
}

export async function fcSetAdminAway(opts: SetAdminAwayOpts): Promise<any> {
  return iWrite('PUT', `/admins/${opts.admin_id}/away`, {
    away_mode_enabled: opts.away_mode_enabled,
    away_mode_reassign: opts.away_mode_reassign,
  });
}

// ===========================================================================
// TEAMS
// ===========================================================================

export async function fcListTeams(): Promise<any> {
  return iGet('/teams');
}

export async function fcGetTeam(team_id: string): Promise<any> {
  return iGet(`/teams/${team_id}`);
}

// ===========================================================================
// TICKET TYPES
// ===========================================================================

export async function fcListTicketTypes(): Promise<any> {
  return iGet('/ticket_types');
}

export async function fcGetTicketType(ticket_type_id: string): Promise<any> {
  return iGet(`/ticket_types/${ticket_type_id}`);
}

export interface CreateTicketTypeOpts {
  name: string;
  description?: string;
  icon?: string;
  is_internal?: boolean;
}

export async function fcCreateTicketType(opts: CreateTicketTypeOpts): Promise<any> {
  return iWrite('POST', '/ticket_types', opts);
}

export interface UpdateTicketTypeOpts {
  ticket_type_id: string;
  name?: string;
  description?: string;
  icon?: string;
  archived?: boolean;
}

export async function fcUpdateTicketType(opts: UpdateTicketTypeOpts): Promise<any> {
  const { ticket_type_id, ...payload } = opts;
  return iWrite('PUT', `/ticket_types/${ticket_type_id}`, payload);
}

// ===========================================================================
// TICKETS
// ===========================================================================

export async function fcGetTicket(ticket_id: string): Promise<any> {
  return iGet(`/tickets/${ticket_id}`);
}

export interface SearchTicketsOpts {
  query: {
    field: string;
    operator: string;
    value: string | number | boolean;
  } | {
    operator: 'AND' | 'OR';
    value: Array<{ field: string; operator: string; value: string | number | boolean }>;
  };
  per_page?: number;
  starting_after?: string;
}

export async function fcSearchTickets(opts: SearchTicketsOpts): Promise<any> {
  const payload: Record<string, unknown> = { query: opts.query };
  if (opts.per_page || opts.starting_after) {
    payload.pagination = { per_page: opts.per_page, starting_after: opts.starting_after };
  }
  return iWrite('POST', '/tickets/search', payload);
}

export interface CreateTicketOpts {
  ticket_type_id: string;
  /** Array of contact objects: [{id: '...'}] or [{email: '...'}] */
  contacts: Array<{ id?: string; email?: string }>;
  ticket_attributes?: Record<string, unknown>;
}

export async function fcCreateTicket(opts: CreateTicketOpts): Promise<any> {
  return iWrite('POST', '/tickets', {
    ticket_type_id: opts.ticket_type_id,
    contacts: opts.contacts,
    ticket_attributes: opts.ticket_attributes ?? {},
  });
}

export interface UpdateTicketOpts {
  ticket_id: string;
  ticket_attributes?: Record<string, unknown>;
  /** submitted | in_progress | waiting_on_customer | resolved */
  state?: string;
  is_shared?: boolean;
  snoozed_until?: number;
  assignment?: { admin_id?: string; team_id?: string };
}

export async function fcUpdateTicket(opts: UpdateTicketOpts): Promise<any> {
  const { ticket_id, ...payload } = opts;
  return iWrite('PUT', `/tickets/${ticket_id}`, payload);
}

// ===========================================================================
// EVENTS (Data Events)
// ===========================================================================

export interface ListEventsOpts {
  type: 'user';
  user_id?: string;
  intercom_user_id?: string;
  email?: string;
  per_page?: number;
}

export async function fcListEvents(opts: ListEventsOpts): Promise<any> {
  return iGet('/events', {
    type: opts.type,
    user_id: opts.user_id,
    intercom_user_id: opts.intercom_user_id,
    email: opts.email,
    per_page: opts.per_page,
  });
}

export interface SubmitEventOpts {
  event_name: string;
  created_at: number;
  user_id?: string;
  email?: string;
  id?: string;
  metadata?: Record<string, string | number | boolean>;
}

export async function fcSubmitEvent(opts: SubmitEventOpts): Promise<any> {
  return iWrite('POST', '/events', opts);
}
