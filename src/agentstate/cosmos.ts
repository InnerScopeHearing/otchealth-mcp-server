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
import { fetchWithBudget } from '../util/fetch-budget.js';

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
  pkRangeId?: string;
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
  if (opts.pkRangeId !== undefined) headers['x-ms-documentdb-partitionkeyrangeid'] = opts.pkRangeId;
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

  // Bounded + one retry: every Cosmos call here is a single-document read/write or a
  // query-by-POST (isQuery), all safe to repeat once on a network blip / 429 / 5xx (see
  // src/util/fetch-budget.ts). Prevents one half-open socket from hanging a request slot
  // forever on a container with no Log Analytics to diagnose it after the fact.
  const r = await fetchWithBudget(`${c.endpoint}/${urlPath}`, {
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
const CONTAINERS = new Set(['tasks', 'memory', 'events', 'oauthcodes', 'cache']);
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

/** Delete a document by id + partition key. Idempotent: treats 404 as success (already gone). */
export async function deleteDoc(coll: string, pkValue: string, id: string): Promise<CosmosResponse> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const link = `dbs/${db()}/colls/${coll}/docs/${id}`;
  const res = await request('DELETE', 'docs', link, link, { pk: pkValue });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Cosmos deleteDoc ${coll}/${id} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
  }
  return res;
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

/** List the physical partition-key-range ids of a container. */
async function pkRanges(coll: string): Promise<string[]> {
  const link = `dbs/${db()}/colls/${coll}`;
  const res = await request('GET', 'pkranges', link, `${link}/pkranges`, {});
  if (!res.ok) throw new Error(`Cosmos pkranges ${coll} -> ${res.status}`);
  const ranges = ((res.body as { PartitionKeyRanges?: { id: string }[] })?.PartitionKeyRanges) ?? [];
  return ranges.map((r) => r.id);
}

/**
 * Run a SQL query. A single-partition query (pk given) is served directly. A CROSS-partition query
 * is executed per partition-key-range and merged: the REST gateway cannot itself fan out queries
 * that use CONTAINS / aggregates ("cannot be directly served by the gateway"), which the SDKs hide
 * behind a query-plan negotiation. Follows continuations up to `max` docs.
 */
export async function queryDocs(
  coll: string,
  query: string,
  parameters: { name: string; value: unknown }[] = [],
  opts: { pk?: string; max?: number } = {},
): Promise<Record<string, unknown>[]> {
  assertColl(coll);
  const max = opts.max ?? 100;
  const link = `dbs/${db()}/colls/${coll}`;

  // A single-page 429 (Cosmos RU throttling) mid-pagination must not throw away every page
  // already collected. `request()` already retries once at the transport level for a genuine
  // network blip; this is a SEPARATE, page-level backoff for Cosmos's own rate-limit response,
  // bounded so a persistently-throttled container fails after a few short waits rather than
  // hanging the recall forever.
  const MAX_PAGE_RETRIES = 3;
  const PAGE_RETRY_BASE_MS = 250;

  const runOne = async (extra: { pk?: string; pkRangeId?: string }): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let continuation: string | undefined;
    do {
      let res: CosmosResponse & { continuation: string | null };
      let pageAttempt = 0;
      for (;;) {
        res = (await request('POST', 'docs', link, `${link}/docs`, {
          isQuery: true,
          body: { query, parameters },
          continuation,
          maxItemCount: 100,
          ...extra,
        })) as CosmosResponse & { continuation: string | null };
        if (res.status === 429 && pageAttempt < MAX_PAGE_RETRIES) {
          pageAttempt++;
          await new Promise((resolve) => setTimeout(resolve, PAGE_RETRY_BASE_MS * pageAttempt));
          continue;
        }
        break;
      }
      if (!res.ok) {
        throw new Error(`Cosmos query ${coll} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 240)}`);
      }
      const docs = ((res.body as { Documents?: Record<string, unknown>[] })?.Documents) ?? [];
      out.push(...docs);
      continuation = res.continuation ?? undefined;
    } while (continuation && out.length < max);
    return out;
  };

  if (opts.pk !== undefined) {
    assertId(opts.pk, 'partition key');
    return (await runOne({ pk: opts.pk })).slice(0, max);
  }

  const ranges = await pkRanges(coll);
  const merged: Record<string, unknown>[] = [];
  for (const rid of ranges) {
    merged.push(...(await runOne({ pkRangeId: rid })));
    if (merged.length >= max) break;
  }
  return merged.slice(0, max);
}

/** A short unique id (used for task/memory/event ids). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export interface VectorMatch {
  doc: Record<string, unknown>;
  similarity: number;
}

/**
 * Cosine-similarity vector search within a single partition, via Cosmos DB for NoSQL's
 * VectorDistance() query function. Scoped to one partition key on purpose (the caller is
 * expected to pass a scope-bounded pk, e.g. a cache scope, so the search never fans out
 * cross-partition). Returns the top `top` matches ordered by similarity, best first, each
 * annotated with its cosine similarity (Cosmos VectorDistance with the cosine distance
 * function returns 1 - cosine_similarity is NOT the case here: for distanceFunction 'cosine'
 * VectorDistance returns the cosine SIMILARITY directly, range [-1, 1], higher = closer).
 */
export async function vectorSearchDocs(
  coll: string,
  pkValue: string,
  vectorField: string,
  vector: number[],
  top = 1,
): Promise<VectorMatch[]> {
  assertColl(coll);
  assertId(pkValue, 'partition key');
  const query =
    `SELECT TOP ${Math.max(1, Math.min(top, 50))} c, VectorDistance(c.${vectorField}, @vec) AS similarity ` +
    `FROM c WHERE c.cacheScope = @scope ORDER BY VectorDistance(c.${vectorField}, @vec)`;
  const rows = await queryDocs(
    coll,
    query,
    [
      { name: '@vec', value: vector },
      { name: '@scope', value: pkValue },
    ],
    { pk: pkValue, max: top },
  );
  return rows
    .map((r) => ({ doc: (r as Record<string, unknown>)['c'] as Record<string, unknown>, similarity: Number((r as Record<string, unknown>)['similarity'] ?? 0) }))
    .filter((m) => m.doc !== undefined && m.doc !== null);
}
