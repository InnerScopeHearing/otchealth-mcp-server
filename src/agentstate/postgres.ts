/**
 * RDS Postgres implementation of the agent-state plane.
 *
 * Mirrors the exported surface of src/agentstate/cosmos.ts exactly -- createDoc, readDoc,
 * replaceDoc, deleteDoc, upsertDoc, queryDocs, vectorSearchDocs, newId, isConfigured -- so
 * src/agentstate/store.ts can dispatch between the two on STATE_BACKEND with no caller changes.
 *
 * DOCUMENT MODEL
 * One table per Cosmos container: (pk text, id text, doc jsonb, etag text), primary key (pk, id).
 * Cosmos's partition key becomes the `pk` column, so a single-partition query is an indexed
 * equality and a cross-partition query simply omits it -- the same distinction Cosmos draws, with
 * the same cost shape.
 *
 * ETAG / OPTIMISTIC CONCURRENCY
 * The ledger's compare-and-swap depends on Cosmos returning 412 (not 404) when a document exists
 * but has moved on. Postgres UPDATE ... WHERE etag = $n reports zero rows for BOTH cases, which
 * would collapse "someone else edited this, re-read and retry" into "this task does not exist" --
 * a live correctness bug in task_update/task_complete rather than a cosmetic status difference.
 * replaceDoc therefore resolves existence and staleness in ONE statement (see below) so the two
 * stay distinguishable without a racy read-then-write.
 *
 * VECTORS
 * pgvector. The embeddings are text-embedding-3-large at 3072 dimensions, which is ABOVE pgvector's
 * 2000-dimension limit for HNSW/IVFFlat indexes, so vector search here is necessarily exact. That
 * is acceptable only because every caller scopes the search to one partition (a cache scope) and
 * asks for a handful of rows; it would not be acceptable for a whole-corpus search.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { translate } from './pg-sql.js';

/** Same allow-list as the Cosmos client: a caller-supplied container must never reach SQL. */
const CONTAINERS = new Set(['tasks', 'memory', 'events', 'oauthcodes', 'cache']);
const ID_RE = /^[A-Za-z0-9_.\-]{1,255}$/;

/** Container -> physical table. Prefixed so the agent-state tables cannot collide with the
 *  restored Flatstick/FourVault application schemas that already live in this instance. */
export function tableFor(coll: string): string {
  if (!CONTAINERS.has(coll)) throw new Error(`unknown container "${coll}" (allowed: ${[...CONTAINERS].join(', ')})`);
  return `agentstate_${coll}`;
}

function assertId(value: string, label = 'id'): void {
  if (typeof value !== 'string' || !ID_RE.test(value) || /^\.+$/.test(value)) {
    throw new Error(`invalid ${label} (must match the agent-state id charset)`);
  }
}

export interface PgResponse<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: T | null;
  etag: string | null;
}

let pool: pg.Pool | null = null;

export function isConfigured(): boolean {
  return Boolean(loadEnv().PG_HOST);
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const env = loadEnv();
  if (!env.PG_HOST) throw new Error('Postgres agent-state not configured (PG_HOST unset).');
  pool = new pg.Pool({
    host: env.PG_HOST,
    port: env.PG_PORT,
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    ssl: { rejectUnauthorized: env.PG_SSL_VERIFY },
    // Bounded so one wedged query cannot exhaust the gateway's request slots, matching the
    // fetch-budget discipline the Cosmos client uses for the same reason.
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // A pool error with no listener is an unhandled 'error' event, which takes the process down.
    // Fargate would restart the task and the cause would be invisible.
  });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[agentstate/postgres] idle client error:', err.message);
  });
  return pool;
}

/** Test seam: drop the cached pool so a test can point at a different instance. */
export async function resetPoolForTests(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

function newEtag(): string {
  return `"${crypto.randomUUID()}"`;
}

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, values);
}

/** Create a document. Duplicate (pk, id) is a 409, matching Cosmos. */
export async function createDoc(coll: string, pkValue: string, doc: Record<string, unknown>): Promise<PgResponse> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  const id = String(doc.id ?? '');
  assertId(id);
  const etag = newEtag();
  try {
    await q(`INSERT INTO ${table} (pk, id, doc, etag) VALUES ($1, $2, $3, $4)`, [pkValue, id, JSON.stringify(doc), etag]);
  } catch (e) {
    // PARITY, not preference: the Cosmos client THROWS on any non-ok create, including a 409
    // duplicate ("if (!res.ok) throw"). Returning a 409 response object here would read as the
    // tidier design and would silently turn an exception every caller currently propagates into a
    // value they all ignore -- a duplicate task or memory would then look like it was written.
    // Match the existing contract; improve it later in one deliberate change across both backends.
    if ((e as { code?: string }).code === '23505') {
      throw new Error(`Postgres createDoc ${coll} -> 409: duplicate id ${id} in partition ${pkValue}`);
    }
    throw new Error(`Postgres createDoc ${coll} -> ${(e as Error).message}`);
  }
  return { status: 201, ok: true, body: doc, etag };
}

/** Read by id + partition key. Returns null-bodied 404 when absent, as the Cosmos client does. */
export async function readDoc(coll: string, pkValue: string, id: string): Promise<{ doc: Record<string, unknown>; etag: string | null } | null> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const r = await q<{ doc: Record<string, unknown>; etag: string }>(
    `SELECT doc, etag FROM ${table} WHERE pk = $1 AND id = $2`,
    [pkValue, id],
  );
  if (!r.rowCount) return null;
  return { doc: r.rows[0].doc, etag: r.rows[0].etag };
}

/**
 * Replace a document, honouring an optional If-Match etag.
 *
 * The single-statement CTE below is load-bearing. A read-then-write would race, and a plain
 * conditional UPDATE cannot tell "absent" from "stale" -- and the ledger's retry logic branches on
 * exactly that difference (412 means re-read and retry, 404 means give up). `present` is computed
 * from a snapshot taken in the same statement as the update, so the two outcomes stay separable
 * without a second round trip.
 */
export async function replaceDoc(
  coll: string,
  pkValue: string,
  id: string,
  doc: Record<string, unknown>,
  ifMatch?: string,
): Promise<PgResponse> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const etag = newEtag();
  const r = await q<{ present: string; updated: string }>(
    `WITH present AS (
       SELECT 1 FROM ${table} WHERE pk = $1 AND id = $2
     ), updated AS (
       UPDATE ${table} SET doc = $3, etag = $4
        WHERE pk = $1 AND id = $2 AND ($5::text IS NULL OR etag = $5)
        RETURNING 1
     )
     SELECT (SELECT count(*) FROM present) AS present, (SELECT count(*) FROM updated) AS updated`,
    [pkValue, id, JSON.stringify(doc), etag, ifMatch ?? null],
  );
  const present = Number(r.rows[0]?.present ?? 0);
  const updated = Number(r.rows[0]?.updated ?? 0);
  if (updated > 0) return { status: 200, ok: true, body: doc, etag };
  if (present === 0) return { status: 404, ok: false, body: null, etag: null };
  return { status: 412, ok: false, body: null, etag: null };
}

/** Delete by id + partition key. 404 when absent, 412 on an etag mismatch. */
export async function deleteDoc(coll: string, pkValue: string, id: string, ifMatch?: string): Promise<PgResponse> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  assertId(id);
  const r = await q<{ present: string; removed: string }>(
    `WITH present AS (
       SELECT 1 FROM ${table} WHERE pk = $1 AND id = $2
     ), removed AS (
       DELETE FROM ${table} WHERE pk = $1 AND id = $2 AND ($3::text IS NULL OR etag = $3) RETURNING 1
     )
     SELECT (SELECT count(*) FROM present) AS present, (SELECT count(*) FROM removed) AS removed`,
    [pkValue, id, ifMatch ?? null],
  );
  const present = Number(r.rows[0]?.present ?? 0);
  const removed = Number(r.rows[0]?.removed ?? 0);
  if (removed > 0) return { status: 204, ok: true, body: null, etag: null };
  if (present === 0) return { status: 404, ok: false, body: null, etag: null };
  return { status: 412, ok: false, body: null, etag: null };
}

/** Insert-or-replace. */
export async function upsertDoc(coll: string, pkValue: string, doc: Record<string, unknown>): Promise<PgResponse> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  const id = String(doc.id ?? '');
  assertId(id);
  const etag = newEtag();
  await q(
    `INSERT INTO ${table} (pk, id, doc, etag) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pk, id) DO UPDATE SET doc = EXCLUDED.doc, etag = EXCLUDED.etag`,
    [pkValue, id, JSON.stringify(doc), etag],
  );
  return { status: 200, ok: true, body: doc, etag };
}

/**
 * Run a Cosmos-SQL query against Postgres.
 *
 * The SQL is translated by src/agentstate/pg-sql.ts, which recognises only the constructs this
 * repo actually uses and THROWS on anything else. That fail-closed behaviour is deliberate: a
 * translator that guessed would return valid-looking, wrong rows, which is the failure mode this
 * whole migration keeps tripping over.
 */
export async function queryDocs(
  coll: string,
  query: string,
  parameters: { name: string; value: unknown }[] = [],
  opts: { pk?: string; max?: number } = {},
): Promise<Record<string, unknown>[]> {
  const table = tableFor(coll);
  if (opts.pk !== undefined) assertId(opts.pk, 'partition key');
  const { text, values } = translate({ table, query, parameters, pk: opts.pk, max: opts.max ?? 100 });
  const r = await q<{ doc: Record<string, unknown> }>(text, values);
  return r.rows.map((row) => row.doc);
}

/** A short unique id. Identical shape to the Cosmos client's, so ids stay comparable across a cutover. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export interface VectorMatch {
  doc: Record<string, unknown>;
  similarity: number;
}

/**
 * Cosine vector search within one partition.
 *
 * pgvector's `<=>` is cosine DISTANCE, so similarity is 1 - distance and "closest" is ASCENDING
 * distance. Cosmos's VectorDistance with distanceFunction 'cosine' returns similarity directly and
 * the caller orders ascending too, so both produce the same ordering -- but the returned NUMBER
 * differs in sign convention, and callers threshold on it (the semantic cache only serves a hit
 * above a similarity floor). Converting here rather than at the call site keeps the two backends
 * returning the same quantity, so a cache-hit threshold means the same thing on both.
 */
export async function vectorSearchDocs(
  coll: string,
  pkValue: string,
  vectorField: string,
  vector: number[],
  top = 1,
): Promise<VectorMatch[]> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(vectorField)) throw new Error(`invalid vector field: ${vectorField}`);
  const n = Math.max(1, Math.min(top, 50));
  // The vector literal binds as a parameter cast to `vector`; it is never interpolated.
  const r = await q<{ doc: Record<string, unknown>; distance: number }>(
    `SELECT doc, (embedding <=> $2::vector) AS distance
       FROM ${table}
      WHERE pk = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT ${n}`,
    [pkValue, JSON.stringify(vector)],
  );
  return r.rows.map((row) => ({ doc: row.doc, similarity: 1 - Number(row.distance) }));
}

/**
 * Write a document together with its embedding. Cosmos stores the vector as an ordinary property
 * of the document; Postgres needs it in a typed `vector` column for pgvector to index or compare
 * it, so the vector is passed separately here and the doc keeps its own copy for round-trip
 * fidelity.
 */
export async function upsertDocWithVector(
  coll: string,
  pkValue: string,
  doc: Record<string, unknown>,
  vector: number[],
): Promise<PgResponse> {
  const table = tableFor(coll);
  assertId(pkValue, 'partition key');
  const id = String(doc.id ?? '');
  assertId(id);
  const etag = newEtag();
  await q(
    `INSERT INTO ${table} (pk, id, doc, etag, embedding) VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (pk, id) DO UPDATE SET doc = EXCLUDED.doc, etag = EXCLUDED.etag, embedding = EXCLUDED.embedding`,
    [pkValue, id, JSON.stringify(doc), etag, JSON.stringify(vector)],
  );
  return { status: 200, ok: true, body: doc, etag };
}
