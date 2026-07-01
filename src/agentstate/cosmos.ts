/**
 * Azure Cosmos DB for NoSQL data-plane client (dependency-free, master-key HMAC auth).
 *
 * This is the write/read path for the AGENT STATE PLANE: the work-ledger (`tasks`),
 * the structured memory-of-record (`memory`), and the append-only transition log (`events`).
 * It talks straight to the Cosmos REST data-plane so no vendor SDK/runtime is required and
 * the gateway stays the single engine-portable front door (any engine calls the gateway tool,
 * the gateway calls Cosmos).
 *
 * Auth (do NOT "tidy" the casing — it is load-bearing, see agentstate.test.ts):
 *   stringToSign = verb.toLowerCase() + "\n" + resType.toLowerCase() + "\n" +
 *                  resourceLink + "\n" + date.toLowerCase() + "\n" + "" + "\n"
 *   sig = base64( HMAC-SHA256( base64decode(masterKey), stringToSign ) )
 *   Authorization = urlencode("type=master&ver=1.0&sig=" + sig)
 * resourceLink keeps its original case (db/container/doc ids are case-sensitive).
 *
 * Inert without creds: if COSMOS_ENDPOINT/COSMOS_KEY are unset, isConfigured() is false and the
 * agent-state tools return a clear "not configured" result instead of throwing.
 */

import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';

/** Cosmos data-plane REST api-version. Supports docs CRUD + cross-partition query. */
const COSMOS_API_VERSION = '2018-12-31';

interface CosmosConfig {
  endpoint: string;
  key: string;
  db: string;
}

function cfg(): CosmosConfig | null {
  const env = loadEnv();
  const endpoint = env.COSMOS_ENDPOINT;
  const key = env.COSMOS_KEY;
  const db = env.COSMOS_DB;
  if (!endpoint || !key) return null;
  return { endpoint: endpoint.replace(/\/+$/, ''), key, db };
}

export function isConfigured(): boolean {
  return cfg() !== null;
}

/** The Cosmos master-key Authorization header value (URL-encoded token). Pure + testable. */
export function authToken(
  verb: string,
  resType: string,
  resourceLink: string,
  date: string,
  masterKey: string,
): string {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto
    .createHmac('sha256', Buffer.from(masterKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

export interface CosmosResponse<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: T | null;
  etag: string | null;
}

interface RequestOptions {
  pk?: string;
  body?: unknown;
  ifMatch?: string;
  isQuery?: boolean;
  upsert?: boolean;
  continuation?: string;
  maxItemCount?: number;
}

async function request(
  verb: string,
  resType: string,
  resourceLink: string,
  urlPath: string,
  opts: RequestOptions = {},
): Promise<CosmosResponse> {
  const c = cfg();
  if (!c) throw new Error('Cosmos agent-state not configured (COSMOS_ENDPOINT/COSMOS_KEY unset).');
  const date = new Date().toUTCString();
  const headers: Record<string, string> = {
    Authorization: authToken(verb, resType, resourceLink, date, c.key),
    'x-ms-date': date,
    'x-ms-version': COSMOS_API_VERSION,
    Accept: 'application/json',
  };
  if (opts.pk !== undefined) headers['x-ms-documentdb-partitionkey'] = JSON.stringify([opts.pk]);
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  if (opts.upsert) headers['x-ms-documentdb-is-upsert'] = 'true';
  if (opts.continuation) headers['x-ms-continuation'] = opts.continuation;
  if (opts.maxItemCount) headers['x-ms-max-item-count'] = String(opts.maxItemCount);
  if (opts.isQuery) {
    headers['Content-Type'] = 'application/query+json';
    headers['x-ms-documentdb-isquery'] = 'true';
    if (opts.pk === undefined) headers['x-ms-documentdb-query-enablecrosspartition'] = 'true';
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const r = await fetch(`${c.endpoint}/${urlPath}`, {
    method: verb,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await r.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = txt ? (JSON.parse(txt) as Record<string, unknown>) : null;
  } catch {
    body = { raw: txt };
  }
  return {
    status: r.status,
    ok: r.ok,
    body,
    etag: r.headers.get('etag'),
    continuation: r.headers.get('x-ms-continuation'),
  } as CosmosResponse & { continuation: string | null };
}

function db(): string {
  const c = cfg();
  if (!c) throw new Error('Cosmos agent-state not configured.');
  return c.db;
}

/**
 * Path-injection guard. Every container name and every id / partition-key value is interpolated
 * into the Cosmos REST resourceLink + URL, so both must be validated against a static allowlist /
 * the Cosmos-safe id charset BEFORE they touch a request. A caller-supplied task_id like
 * "../colls/other/docs/x" must never escape its container.
 */
const CONTAINERS = new Set(['tasks', 'memory', 'events']);
const ID_RE = /^[A-Za-z0-9_.\-]{1,255}$/;
function assertColl(coll: string): void {
  if (!CONTAINERS.has(coll)) throw new Error(`unknown container "${coll}" (allowed: ${[...CONTAINERS].join(', ')})`);
}
function assertId(value: string, label = 'id'): void {
  if (typeof value !== 'string' || !ID_RE.test(value) || /^\.+$/.test(value)) {
    throw new Error(`invalid ${label} (must match Cosmos id charset)`);
  }
}

/** Create a document in a container (partition key value required). */
export async function createDoc(
  coll: string,
  pkValue: string,
  doc: Record<string, unknown>,
): Promise<CosmosResponse> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  const link = `dbs/${db()}/colls/${coll}`;
  const res = await request('POST', 'docs', link, `${link}/docs`, { pk: pkValue, body: doc });
  if (!res.ok) throw new Error(`Cosmos createDoc ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return res;
}

/** Read a document by id + partition key. Returns null on 404. */
export async function readDoc(
  coll: string,
  pkValue: string,
  id: string,
): Promise<{ doc: Record<string, unknown>; etag: string | null } | null> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const link = `dbs/${db()}/colls/${coll}/docs/${id}`;
  const res = await request('GET', 'docs', link, link, { pk: pkValue });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cosmos readDoc ${coll}/${id} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return { doc: res.body as Record<string, unknown>, etag: res.etag };
}

/** Replace a document (optimistic concurrency via ifMatch etag). Returns {ok, status, doc, etag}. */
export async function replaceDoc(
  coll: string,
  pkValue: string,
  id: string,
  doc: Record<string, unknown>,
  ifMatch?: string,
): Promise<CosmosResponse> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const link = `dbs/${db()}/colls/${coll}/docs/${id}`;
  return request('PUT', 'docs', link, link, { pk: pkValue, body: doc, ifMatch });
}

/** Upsert a document. */
export async function upsertDoc(
  coll: string,
  pkValue: string,
  doc: Record<string, unknown>,
): Promise<CosmosResponse> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  const link = `dbs/${db()}/colls/${coll}`;
  const res = await request('POST', 'docs', link, `${link}/docs`, { pk: pkValue, body: doc, upsert: true });
  if (!res.ok) throw new Error(`Cosmos upsertDoc ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  return res;
}

/** Run a SQL query (cross-partition by default). Follows continuations up to `max` docs. */
export async function queryDocs(
  coll: string,
  query: string,
  parameters: { name: string; value: unknown }[] = [],
  opts: { pk?: string; max?: number } = {},
): Promise<Record<string, unknown>[]> {
  assertColl(coll);
  if (opts.pk !== undefined) assertId(opts.pk, 'partition key');
  const link = `dbs/${db()}/colls/${coll}`;
  const max = opts.max ?? 100;
  const out: Record<string, unknown>[] = [];
  let continuation: string | undefined;
  do {
    const res = (await request('POST', 'docs', link, `${link}/docs`, {
      isQuery: true,
      body: { query, parameters },
      pk: opts.pk,
      continuation,
      maxItemCount: Math.min(100, max),
    })) as CosmosResponse & { continuation: string | null };
    if (!res.ok) {
      throw new Error(`Cosmos query ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
    }
    const docs = ((res.body as { Documents?: Record<string, unknown>[] })?.Documents) ?? [];
    out.push(...docs);
    continuation = res.continuation ?? undefined;
  } while (continuation && out.length < max);
  return out.slice(0, max);
}

/** A short unique id (used for task/memory/event ids). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}
