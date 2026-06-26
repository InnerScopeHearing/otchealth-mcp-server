/**
 * Intercom WRITE client — NEW file, self-contained.
 * Auth pattern mirrors src/intercom/client.ts exactly (Bearer token,
 * Intercom-Version 2.11 header, same IntercomApiError shape, same mapError).
 * This file is self-contained so the read client is never modified (hard rule).
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const BASE = 'https://api.intercom.io';
const INTERCOM_VERSION = '2.11';

// ---- Error class (mirrors IntercomApiError) ----

export class IntercomWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'IntercomWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireToken(): string {
  if (!env.INTERCOM_ACCESS_TOKEN) {
    throw new IntercomWriteError({
      code: 'intercom_not_configured',
      status: 0,
      message: 'Intercom integration is not configured.',
      nextStep: "Set INTERCOM_ACCESS_TOKEN in Railway env vars. Value is in Matt's Notion Token Vault under Intercom section.",
    });
  }
  return env.INTERCOM_ACCESS_TOKEN;
}

function mapError(status: number, path: string, body: string): IntercomWriteError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep raw */ }
  if (status === 401 || status === 403) {
    return new IntercomWriteError({
      code: 'intercom_auth_failed',
      status,
      message: `Intercom rejected auth on ${path}.`,
      nextStep: 'Confirm INTERCOM_ACCESS_TOKEN in Railway matches the Notion vault value.',
      upstream,
    });
  }
  if (status === 404) {
    return new IntercomWriteError({
      code: 'intercom_not_found',
      status,
      message: `Intercom returned 404 for ${path}.`,
      nextStep: 'Verify the contact/conversation/article ID. Use list tools to find valid IDs.',
      upstream,
    });
  }
  if (status === 429) {
    return new IntercomWriteError({
      code: 'intercom_rate_limited',
      status,
      message: 'Intercom rate-limited the call.',
      nextStep: 'Back off and retry.',
      upstream,
    });
  }
  return new IntercomWriteError({
    code: status >= 500 ? 'intercom_upstream_error' : 'intercom_request_error',
    status,
    message: `Intercom returned ${status} for ${path}.`,
    nextStep: status >= 500 ? 'Check https://www.intercomstatus.com/ and retry.' : 'Verify input parameters against Intercom API docs.',
    upstream,
  });
}

async function intercomWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = requireToken();
  const url = `${BASE}${path}`;
  const res = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Intercom-Version': INTERCOM_VERSION,
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
// Write operations
// ===========================================================================

// ---- Create contact ----

export interface CreateContactOpts {
  role: 'user' | 'lead';
  email?: string;
  name?: string;
  phone?: string;
  /** External id from your system */
  external_id?: string;
  custom_attributes?: Record<string, unknown>;
}

export async function createContact(opts: CreateContactOpts): Promise<any> {
  return intercomWrite('POST', '/contacts', opts);
}

// ---- Create conversation ----

export interface CreateConversationOpts {
  /** Intercom contact id to attach this conversation to */
  from_contact_id: string;
  /** Opening message body (plain text or HTML) */
  body: string;
}

export async function createConversation(opts: CreateConversationOpts): Promise<any> {
  return intercomWrite('POST', '/conversations', {
    from: { type: 'contact', id: opts.from_contact_id },
    body: opts.body,
  });
}

// ---- Reply to conversation ----

export type ReplyType = 'comment' | 'note';

export interface ReplyConversationOpts {
  conversation_id: string;
  /** 'comment' sends to user; 'note' is internal only */
  type: ReplyType;
  body: string;
  /** admin_id required when replying as a teammate */
  admin_id?: string;
}

export async function replyConversation(opts: ReplyConversationOpts): Promise<any> {
  const payload: any = { type: opts.type, body: opts.body };
  if (opts.admin_id) {
    payload.message_type = opts.type;
    payload.type = 'admin';
    payload.admin_id = opts.admin_id;
  }
  return intercomWrite('POST', `/conversations/${opts.conversation_id}/reply`, payload);
}

// ---- Add internal note ----

export interface AddNoteOpts {
  conversation_id: string;
  body: string;
  /** admin_id of the author (required by Intercom for notes) */
  admin_id: string;
}

export async function addNote(opts: AddNoteOpts): Promise<any> {
  return intercomWrite('POST', `/conversations/${opts.conversation_id}/reply`, {
    type: 'admin',
    message_type: 'note',
    body: opts.body,
    admin_id: opts.admin_id,
  });
}

// ---- Create article ----

export interface CreateArticleOpts {
  title: string;
  body?: string;
  /** Intercom admin id who authors the article */
  author_id: number;
  description?: string;
  state?: 'draft' | 'published';
  /** parent collection id */
  parent_id?: number;
  parent_type?: 'collection' | 'section';
}

export async function createArticle(opts: CreateArticleOpts): Promise<any> {
  return intercomWrite('POST', '/articles', opts);
}

// ---- Update article ----

export interface UpdateArticleOpts {
  article_id: string;
  title?: string;
  body?: string;
  description?: string;
  state?: 'draft' | 'published';
  author_id?: number;
  parent_id?: number;
  parent_type?: 'collection' | 'section';
}

export async function updateArticle(opts: UpdateArticleOpts): Promise<any> {
  const { article_id, ...payload } = opts;
  return intercomWrite('PUT', `/articles/${article_id}`, payload);
}
