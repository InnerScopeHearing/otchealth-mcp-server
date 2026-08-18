/**
 * RDS Postgres implementation of the AGENT INBOX (src/agentstate/queue-azure.ts's exact surface:
 * isConfigured, ensureQueue, enqueue, readMessages), selected by src/agentstate/queue.ts (the
 * dispatcher) when STATE_BACKEND=postgres.
 *
 * This is a SEPARATE table from the generic document store in postgres.ts (agentstate_tasks /
 * agentstate_memory / ...): a queue needs an atomic CLAIM (delete-or-hide exactly one copy of a
 * row per concurrent reader), which the doc store's single-row-by-(pk,id) CRUD surface cannot
 * express. This file therefore does NOT import postgres.ts -- doing so would itself violate
 * agentstate-dependency-guard.test.ts, which restricts direct cosmos.js/postgres.js imports to
 * store.ts alone -- and instead opens its own `pg` pool, duplicating postgres.ts's connection
 * setup (same convention this repo already uses for search/azure-dependency-guard.test.ts vs.
 * agentstate-dependency-guard.test.ts: parallel, independently-auditable adapters rather than a
 * shared base that would let one file's mistake reach two backends).
 *
 * SCHEMA (SELF-PROVISIONED on first use by ensureSchema(), memoized per process). This is
 * deliberate and was a correction during review: this repo has NO committed migration mechanism --
 * no .sql files, no scripts/migrate*, no DDL in Terraform -- and the existing agentstate_* tables
 * were applied by hand and never captured in git. Meanwhile the dispatcher already selects on
 * STATE_BACKEND, which is ALREADY `postgres` in production. A "provisioned out of band" design
 * would therefore have armed a fleet-wide break of agent_dispatch / inbox_read / wake at the next
 * deploy, waiting on a manual step this codebase has demonstrably forgotten before. The DDL is
 * idempotent (IF NOT EXISTS) and safe to race between replicas; a FAILED provision is never cached,
 * so a transient error cannot permanently convince a process the schema is unavailable:
 *
 *   CREATE TABLE IF NOT EXISTS agentstate_queue (
 *     seq           bigserial PRIMARY KEY,
 *     queue         text NOT NULL,
 *     message_id    text NOT NULL,
 *     payload       jsonb NOT NULL,
 *     enqueued_at   timestamptz NOT NULL DEFAULT now(),
 *     visible_at    timestamptz NOT NULL DEFAULT now(),
 *     expires_at    timestamptz NOT NULL,
 *     dequeue_count integer NOT NULL DEFAULT 0
 *   );
 *   CREATE UNIQUE INDEX IF NOT EXISTS agentstate_queue_message_id_idx ON agentstate_queue (message_id);
 *   CREATE INDEX IF NOT EXISTS agentstate_queue_ready_idx ON agentstate_queue (queue, visible_at, seq);
 *
 * DRAIN vs PEEK (the whole point of a queue -- get this wrong and messages are lost or replayed
 * forever)
 *   DRAIN (ack=true, inbox_read's default): a single `DELETE ... WHERE seq IN (SELECT ... FOR
 *   UPDATE SKIP LOCKED) RETURNING ...`. The row is gone the instant this statement commits; there
 *   is no window in which a second reader could see it.
 *   PEEK (ack=false, wake's mode): a single `UPDATE ... SET visible_at = now() + Nsec FROM
 *   (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`. The row is never deleted; it is simply
 *   hidden from `readMessages` (both modes) until `visible_at` passes, then reappears --
 *   byte-identical semantics to the Azure client's visibilitytimeout=N with no DELETE call,
 *   which is exactly what wake's `ack:false` relies on today.
 *
 * CONCURRENT READERS (two gateway replicas can call readMessages for the SAME agent at the SAME
 * moment): both statements above select their candidate rows via a subquery carrying `FOR UPDATE
 * SKIP LOCKED`. Postgres row locks make that subquery's row-selection and the outer
 * DELETE/UPDATE's row-mutation atomic with respect to every OTHER transaction running the same
 * statement shape: transaction A's SELECT...FOR UPDATE takes a row lock the instant it selects a
 * row, and transaction B's own FOR UPDATE SKIP LOCKED on the same query simply skips any row A
 * already holds -- it can never select it too. So of two concurrent drains, each ready row is
 * deleted by exactly one of them; of two concurrent peeks, each ready row's visibility is
 * extended by exactly one of them. This is the standard Postgres "competing consumers" queue
 * pattern (the same one SELECT ... FOR UPDATE SKIP LOCKED job-queue recipes use), not read-then-
 * write in two statements, which is exactly the shape that would race.
 *
 * ORDERING: rows are claimed oldest-`seq`-first (an auto-incrementing bigserial), which is FIFO
 * within a queue and at least as strong an ordering guarantee as Azure Queue Storage's own
 * "generally FIFO, not guaranteed" delivery order.
 *
 * TTL / EXPIRY: `expires_at` is set once at enqueue time (`enqueued_at + ttlSeconds`) and both the
 * drain and peek claim queries exclude any row past it, so an expired message is never delivered
 * -- matching Azure's behaviour that an expired message stops being returned. UNLIKE Azure, this
 * adapter does not itself garbage-collect expired rows out of the table (Azure auto-removes them
 * server-side; here they simply become permanently unreachable dead rows once expired). This is a
 * known, flagged gap: harmless for correctness (an expired row can never be claimed or counted),
 * but it is an unbounded-growth risk for a queue/agent pair nobody ever reads, and needs a
 * periodic sweep (`DELETE FROM agentstate_queue WHERE expires_at <= now()`) added to whatever
 * nightly job already exists for this repo's other durable-state hygiene, before this backend
 * carries real production traffic.
 *
 * FAILURE SHAPE: every function throws (never returns an empty-looking success) when Postgres is
 * unreachable, unauthenticated, or the table is missing -- the underlying `pg` error propagates
 * unmodified. There is no catch-and-return-[] anywhere in this file. See the module doc on
 * queue-azure.ts / queue.ts for why that distinction is the single most important property of
 * this whole subsystem.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { queueName, type InboxMessage, type ReadMessage, type ReadMessagesOptions } from './queue-shared.js';

export type { InboxMessage, ReadMessage };
export { queueName };

const TABLE = 'agentstate_queue';

export function isConfigured(): boolean {
  return Boolean(loadEnv().PG_HOST);
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const env = loadEnv();
  if (!env.PG_HOST) throw new Error('Postgres agent inbox not configured (PG_HOST unset).');
  pool = new pg.Pool({
    host: env.PG_HOST,
    port: env.PG_PORT,
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    ssl: { rejectUnauthorized: env.PG_SSL_VERIFY },
    // Bounded so one wedged query cannot exhaust the gateway's request slots -- same discipline as
    // postgres.ts's pool, sized smaller because the inbox's statements are single-row-batch and
    // short-lived (no vector search, no large-document round trips).
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // A pool error with no listener is an unhandled 'error' event, which takes the process down;
    // an idle client dying (e.g. an RDS failover) must not crash the gateway.
    // eslint-disable-next-line no-console
    console.error('[agentstate/queue-postgres] idle client error:', err.message);
  });
  return pool;
}

/**
 * Create the table on first use, idempotently, once per process.
 *
 * WHY THIS IS HERE RATHER THAN IN A MIGRATION (2026-08-18, CTO review of this change). This repo has
 * NO committed migration mechanism -- searched exhaustively: no .sql files, no scripts/migrate*, no
 * DDL in Terraform. The existing agentstate_* tables were applied by hand and never captured in git.
 * So "provision it out of band first" is not a process here; it is an instruction someone has to
 * remember, and this codebase has already demonstrated it does not.
 *
 * That matters because the dispatcher selects on STATE_BACKEND, which is ALREADY `postgres` in
 * production. Shipping this without the table would have switched agent_dispatch / inbox_read /
 * wake's inbox peek onto a table that does not exist, breaking agent-to-agent dispatch fleet-wide at
 * the next deploy -- a landmine armed by merging, not by any later decision.
 *
 * CREATE TABLE IF NOT EXISTS is idempotent and concurrency-safe here: two replicas racing it both
 * succeed. Memoized so it costs one round trip per process, not one per message. If the database
 * role lacks DDL rights this THROWS, loudly and diagnosably, which is the correct failure -- far
 * better than an inbox that silently reads as empty.
 */
let schemaReady: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        seq           bigserial PRIMARY KEY,
        queue         text NOT NULL,
        message_id    text NOT NULL,
        payload       jsonb NOT NULL,
        enqueued_at   timestamptz NOT NULL DEFAULT now(),
        visible_at    timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        dequeue_count integer NOT NULL DEFAULT 0
      )`);
    await getPool().query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_message_id_idx ON ${TABLE} (message_id)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_ready_idx ON ${TABLE} (queue, visible_at, seq)`,
    );
  })().catch((e) => {
    // Do NOT cache a failure: a transient connection error must not permanently convince this
    // process the schema is unavailable. Same reasoning as the retraction cache in memory/.
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

/** Test seam: drop the cached pool so a test can point at a different instance. */
export async function resetPoolForTests(): Promise<void> {
  const p = pool;
  pool = null;
  schemaReady = null;
  if (p) await p.end();
}

/**
 * Provisions the shared table, matching the Azure peer's contract. There is no PER-AGENT physical
 * queue to create -- every agent's messages are rows in the one `agentstate_queue` table,
 * distinguished by the `queue` column -- but the Azure client's ensureQueue (queue-azure.ts:51)
 * really does create storage and really does throw when it cannot, so this one does too.
 *
 * CONSEQUENCE, deliberate: against an unreachable or DDL-denied database this REJECTS rather than
 * resolving. An ensureQueue that resolves means "the inbox is ready"; returning that when it is
 * not is a plausible value returned on failure, which is the one thing this whole subsystem is
 * written to prevent. Pinned by queue-postgres-unreachable.test.ts and
 * queue-postgres-ddl-denied.test.ts.
 */
export async function ensureQueue(agent: string): Promise<void> {
  if (!isConfigured()) throw new Error('Postgres agent inbox not configured (PG_HOST unset).');
  queueName(agent); // validates/normalizes; throws on a bad agent id exactly like the Azure path.
  // The Azure peer CREATES the queue here. Match that contract rather than only validating, so a
  // caller that provisions up front gets the same guarantee from either backend.
  await ensureSchema();
}

/** Coerce one claimed row into the caller-facing ReadMessage shape, defensively (see module header:
 *  jsonb round-trips reliably, but a row inserted by something other than enqueue() below should
 *  degrade the same way the Azure client degrades an unparseable payload, not throw and hide every
 *  OTHER ready message behind one bad row). */
function toReadMessage(agent: string, row: { message_id: string; payload: unknown; dequeue_count: number }, acked: boolean): ReadMessage {
  const p = row.payload;
  const isMsg = p && typeof p === 'object' && typeof (p as Record<string, unknown>).body === 'string';
  const base: InboxMessage = isMsg
    ? (p as InboxMessage)
    : { to: agent, from: 'unknown', subject: '(unparseable)', body: JSON.stringify(p ?? null), ts: '' };
  return { ...base, message_id: row.message_id, dequeue_count: row.dequeue_count, acked };
}

/** Enqueue a message to <agent>'s inbox. */
export async function enqueue(agent: string, msg: InboxMessage, ttlSeconds = 604800): Promise<void> {
  if (!isConfigured()) throw new Error('Postgres agent inbox not configured (PG_HOST unset).');
  const q = queueName(agent);
  await ensureSchema();
  const messageId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, ttlSeconds) * 1000);
  await getPool().query(
    `INSERT INTO ${TABLE} (queue, message_id, payload, enqueued_at, visible_at, expires_at)
     VALUES ($1, $2, $3::jsonb, $4, $4, $5)`,
    [q, messageId, JSON.stringify(msg), now.toISOString(), expiresAt.toISOString()],
  );
}

/**
 * Read up to `max` messages from <agent>'s inbox. ack=true (default) DRAINS: each returned
 * message is deleted, atomically, as part of the same statement that selected it. ack=false PEEKS:
 * messages are claimed (dequeue_count bumped, visible_at pushed out by visibilitySec) but never
 * deleted, so they reappear for any reader once that window passes -- they are NEVER consumed.
 */
export async function readMessages(agent: string, opts: ReadMessagesOptions = {}): Promise<ReadMessage[]> {
  const { max = 16, ack = true, visibilitySec = 60 } = opts;
  if (!isConfigured()) throw new Error('Postgres agent inbox not configured (PG_HOST unset).');
  const q = queueName(agent);
  await ensureSchema();
  const n = Math.min(32, Math.max(1, max));
  const vis = Math.max(1, Math.floor(visibilitySec));
  const p = getPool();

  if (ack) {
    // DRAIN. The DELETE and the row-selecting subquery are ONE statement, so no other transaction
    // can observe (let alone re-claim) a row between "pick it" and "remove it" -- see the module
    // header for why a separate SELECT-then-DELETE would race across concurrent replicas.
    // dequeue_count + 1 in RETURNING (not a separate UPDATE): this fetch counts as a dequeue too,
    // matching Azure Queue Storage, where GetMessages increments DequeueCount as part of the same
    // call that then gets deleted -- a drain is "fetched once, immediately removed", not "removed
    // without ever having been counted as fetched".
    //
    // The outer SELECT ... ORDER BY seq is load-bearing, not decoration: a DELETE's RETURNING rows
    // come back in the statement's own scan order, which is NOT guaranteed to match the inner
    // subquery's `ORDER BY seq` (proven by this file's own test -- five sequential enqueues came
    // back out of order without this). Wrapping the DELETE in a CTE and re-sorting the CTE's output
    // is the only part of this query that actually guarantees FIFO delivery order.
    const r = await p.query<{ message_id: string; payload: unknown; dequeue_count: number }>(
      `WITH claimed AS (
         DELETE FROM ${TABLE}
          WHERE seq IN (
            SELECT seq FROM ${TABLE}
             WHERE queue = $1 AND visible_at <= now() AND expires_at > now()
             ORDER BY seq
             LIMIT $2
               FOR UPDATE SKIP LOCKED
          )
          RETURNING seq, message_id, payload, dequeue_count + 1 AS dequeue_count
       )
       SELECT message_id, payload, dequeue_count FROM claimed ORDER BY seq`,
      [q, n],
    );
    return r.rows.map((row) => toReadMessage(agent, row, true));
  }

  // PEEK. Same FOR-UPDATE-SKIP-LOCKED claim, but an UPDATE that only pushes visible_at out --
  // nothing is ever removed by this branch. Same outer-ORDER-BY requirement as the DRAIN branch
  // above: an UPDATE's RETURNING order is not guaranteed to match the FROM subquery's order either.
  const r = await p.query<{ message_id: string; payload: unknown; dequeue_count: number }>(
    `WITH claimed AS (
       UPDATE ${TABLE} t
          SET dequeue_count = t.dequeue_count + 1,
              visible_at = now() + ($3 * interval '1 second')
         FROM (
            SELECT seq FROM ${TABLE}
             WHERE queue = $1 AND visible_at <= now() AND expires_at > now()
             ORDER BY seq
             LIMIT $2
               FOR UPDATE SKIP LOCKED
         ) c
        WHERE t.seq = c.seq
        RETURNING t.seq, t.message_id, t.payload, t.dequeue_count
     )
     SELECT message_id, payload, dequeue_count FROM claimed ORDER BY seq`,
    [q, n, vis],
  );
  return r.rows.map((row) => toReadMessage(agent, row, false));
}
