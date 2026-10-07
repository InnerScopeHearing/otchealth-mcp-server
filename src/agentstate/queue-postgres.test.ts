// Real-Postgres integration tests for the AGENT INBOX's STATE_BACKEND=postgres adapter
// (queue-postgres.ts). Runs against a local PostgreSQL 16 instance with the agentstate_queue
// table already provisioned (see the DDL in queue-postgres.ts's module header -- this test
// assumes it, it does not create it, matching the "provisioned out of band" design).
//
// Own file (own `node --test` child process): loadEnv() memoizes per-process, same reasoning as
// cosmos-aad.test.ts / cosmos-keymode.test.ts. This file's whole env snapshot (PG_HOST pointing at
// the real local instance, table present) must not collide with queue-postgres-unreachable.test.ts
// (PG_HOST pointing nowhere) or queue-postgres-missing-table.test.ts (PG_HOST pointing at a real
// instance with no agentstate_queue table) -- see those files for why each needs its own process.
//
// Deliberately imports queue-postgres.ts DIRECTLY, not the queue.ts dispatcher -- allow-listed in
// queue-dependency-guard.test.ts for exactly this reason (the inbox's counterpart to
// agentstate.test.ts importing cosmos.ts directly to pin its auth-token construction).
//
// Requires: local `postgres` role/password `postgres` reachable at 127.0.0.1:5432, database
// `agentstate_test` holding the agentstate_queue table (see this repo's dispatch notes for the
// exact DDL run to provision it in this sandbox).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

process.env.STATE_BACKEND = 'postgres';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = 'agentstate_test';
process.env.PG_USER = 'postgres';
process.env.PG_PASSWORD = 'postgres';
process.env.PG_SSL_VERIFY = 'false';

const { isConfigured, ensureQueue, enqueue, readMessages, queueName, resetPoolForTests } = await import('./queue-postgres.js');
// Raw pg used only to inspect/clean table state between tests -- not the code under test.
const pg = (await import('pg')).default;
const rawPool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'agentstate_test',
  user: 'postgres',
  password: 'postgres',
  ssl: { rejectUnauthorized: false },
});

function uniqueAgent(label: string): string {
  // normalizeAgent's charset is ^[a-z0-9][a-z0-9_-]{0,40}$ -- lowercase, digits, -, _ only.
  return `t-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

before(async () => {
  await rawPool.query('SELECT 1'); // fail fast with a clear message if the local DB isn't up
});

after(async () => {
  await resetPoolForTests();
  await rawPool.end();
});

test('isConfigured is true once PG_HOST is set', () => {
  assert.equal(isConfigured(), true);
});

test('ensureQueue resolves against a reachable DB (it provisions the shared table; there is no per-agent object)', async () => {
  // Not a no-op: ensureQueue runs the idempotent schema DDL, matching queue-azure.ts's ensureQueue,
  // which really does create storage. What it does NOT do is create anything per-agent -- every
  // agent's messages are rows in the one shared table, keyed by the `queue` column. The failure
  // side of this contract (unreachable / DDL-denied must REJECT, never resolve) is pinned in
  // queue-postgres-unreachable.test.ts and queue-postgres-ddl-denied.test.ts.
  await assert.doesNotReject(() => ensureQueue(uniqueAgent('ensure')));
});

test('DRAIN (ack=true, default): consumes -- a message read once is never read again', async () => {
  const agent = uniqueAgent('drain');
  await enqueue(agent, { to: agent, from: 'cto', subject: 'hello', body: 'first', ts: new Date().toISOString() });

  const first = await readMessages(agent, { max: 8 }); // ack defaults true
  assert.equal(first.length, 1);
  assert.equal(first[0].body, 'first');
  assert.equal(first[0].acked, true);
  assert.equal(first[0].dequeue_count, 1);

  const second = await readMessages(agent, { max: 8 });
  assert.equal(second.length, 0, 'a drained message must never be delivered again');
});

test('PEEK (ack=false) is read-only: it does not consume, hide, or count as a delivery', async () => {
  const agent = uniqueAgent('peek');
  await enqueue(agent, { to: agent, from: 'cto', subject: 'peek-me', body: 'peek body', ts: new Date().toISOString() });

  // wake peeks on every boot: five peeks in a row must all see the same message, untouched.
  let firstId = '';
  for (let i = 0; i < 5; i++) {
    const peeked = await readMessages(agent, { max: 8, ack: false });
    assert.equal(peeked.length, 1, `peek ${i + 1} must still see the message (a peek hides nothing)`);
    assert.equal(peeked[0].acked, false);
    assert.equal(peeked[0].dequeue_count, 0, 'a peek is not a delivery attempt');
    if (i === 0) firstId = peeked[0].message_id;
    else assert.equal(peeked[0].message_id, firstId);
  }
  const stored = await rawPool.query('SELECT dequeue_count FROM agentstate_queue WHERE message_id = $1', [firstId]);
  assert.equal(stored.rows[0].dequeue_count, 0, 'the stored counter must not move on a peek');

  // A drain right after the peeks (wake, then inbox_read) gets the SAME message: nothing was leased.
  const drained = await readMessages(agent, { max: 8, ack: true });
  assert.equal(drained.length, 1);
  assert.equal(drained[0].message_id, firstId, 'must be the identical message, not a new one');
  assert.equal(drained[0].dequeue_count, 1, 'the drain is the one real delivery');

  const afterDrain = await readMessages(agent, { max: 8, ack: true });
  assert.equal(afterDrain.length, 0);
});

test('two concurrent DRAINS never double-deliver (FOR UPDATE SKIP LOCKED under real concurrency)', async () => {
  const agent = uniqueAgent('race');
  const TOTAL = 40;
  for (let i = 0; i < TOTAL; i++) {
    await enqueue(agent, { to: agent, from: 'cto', subject: `m${i}`, body: `body-${i}`, ts: new Date().toISOString() });
  }

  // Five readers race for the same 40 messages, concurrently, each willing to take up to 32
  // (readMessages' own cap) -- if the claim were read-then-write instead of one atomic statement,
  // this is exactly the shape that would double-deliver under real overlapping connections.
  const READERS = 5;
  const results = await Promise.all(
    Array.from({ length: READERS }, () => readMessages(agent, { max: 32, ack: true })),
  );

  const allIds = results.flatMap((r) => r.map((m) => m.message_id));
  assert.equal(allIds.length, TOTAL, `expected exactly ${TOTAL} messages delivered across all readers, got ${allIds.length}`);
  assert.equal(new Set(allIds).size, TOTAL, 'every delivered message_id must be unique -- a duplicate means double-delivery');

  const remaining = await readMessages(agent, { max: 32, ack: true });
  assert.equal(remaining.length, 0, 'nothing should be left after all 40 were claimed across the 5 readers');
});

test('concurrent PEEKS are read-only: every reader sees every message and a drain still gets them all', async () => {
  const agent = uniqueAgent('peekrace');
  const TOTAL = 10;
  for (let i = 0; i < TOTAL; i++) {
    await enqueue(agent, { to: agent, from: 'cto', subject: `p${i}`, body: `pbody-${i}`, ts: new Date().toISOString() });
  }

  const results = await Promise.all([
    readMessages(agent, { max: 32, ack: false }),
    readMessages(agent, { max: 32, ack: false }),
    readMessages(agent, { max: 32, ack: false }),
  ]);
  const expected = results[0].map((m) => m.message_id);
  assert.equal(expected.length, TOTAL);
  for (const r of results) assert.deepEqual(r.map((m) => m.message_id), expected, 'a peek claims nothing, so every reader sees everything');

  const drained = await readMessages(agent, { max: 32, ack: true });
  assert.equal(drained.length, TOTAL, 'peeking must never consume messages, even under concurrency');
  assert.ok(drained.every((m) => m.dequeue_count === 1), 'only the drain counted as a delivery');
});

test('ordering is FIFO within a queue', async () => {
  const agent = uniqueAgent('fifo');
  for (let i = 0; i < 5; i++) {
    await enqueue(agent, { to: agent, from: 'cto', subject: `f${i}`, body: `${i}`, ts: new Date().toISOString() });
  }
  const msgs = await readMessages(agent, { max: 10, ack: true });
  assert.deepEqual(msgs.map((m) => m.body), ['0', '1', '2', '3', '4']);
});

test('a queue is isolated from another agent\'s queue', async () => {
  const a = uniqueAgent('iso-a');
  const b = uniqueAgent('iso-b');
  await enqueue(a, { to: a, from: 'cto', subject: 's', body: 'for-a', ts: new Date().toISOString() });
  const bMessages = await readMessages(b, { max: 8 });
  assert.equal(bMessages.length, 0, 'agent b must not see agent a\'s message');
  const aMessages = await readMessages(a, { max: 8 });
  assert.equal(aMessages.length, 1);
});

test('expired messages (ttlSeconds) are never delivered, by drain or peek', async () => {
  const agent = uniqueAgent('ttl');
  await enqueue(agent, { to: agent, from: 'cto', subject: 'short-lived', body: 'x', ts: new Date().toISOString() }, 1);
  await new Promise((r) => setTimeout(r, 1300));
  const peeked = await readMessages(agent, { max: 8, ack: false });
  assert.equal(peeked.length, 0);
  const drained = await readMessages(agent, { max: 8, ack: true });
  assert.equal(drained.length, 0);
  // Expired is not erased: it is dead-lettered and stays retrievable for audit.
  const audit = await readMessages(agent, { max: 8, deadLetter: true });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].dead_letter_reason, 'expired');
});

test('the agent id is validated/normalized (invalid ids are rejected, not silently accepted)', async () => {
  await assert.rejects(() => enqueue('not a valid id!', { to: 'x', from: 'cto', subject: 's', body: 'b', ts: '' }));
  await assert.rejects(() => readMessages('not a valid id!'));
});

test('dead letter: a message fetched more than maxDeliveries times leaves peeks and drains but stays auditable', async () => {
  const agent = uniqueAgent('dlq-count');
  const ts = new Date().toISOString();
  await enqueue(agent, { to: agent, from: 'cto', subject: 'poison', body: 'poison', ts });
  await enqueue(agent, { to: agent, from: 'cto', subject: 'healthy', body: 'healthy', ts });
  // A legacy row whose counter was inflated by the old peek-leasing (production showed 79-138).
  await rawPool.query(`UPDATE agentstate_queue SET dequeue_count = 120 WHERE queue = $1 AND payload->>'body' = 'poison'`, [queueName(agent)]);

  assert.deepEqual((await readMessages(agent, { ack: false })).map((m) => m.body), ['healthy'], 'the default threshold (50) retires a 120-delivery message');
  const audit = await readMessages(agent, { deadLetter: true });
  assert.deepEqual(audit.map((m) => [m.body, m.dead_letter_reason, m.dequeue_count]), [['poison', 'max_deliveries', 120]]);
  assert.deepEqual((await readMessages(agent, { ack: true })).map((m) => m.body), ['healthy']);

  // Ack semantics are unchanged AND the dead letter survived the drain: retained for audit, not deleted.
  const rows = await rawPool.query('SELECT count(*)::int AS n FROM agentstate_queue WHERE queue = $1', [queueName(agent)]);
  assert.equal(rows.rows[0].n, 1);
  assert.equal((await readMessages(agent, { deadLetter: true })).length, 1);
});

test('dead letter: the threshold is strictly "more than" maxDeliveries', async () => {
  const agent = uniqueAgent('dlq-edge');
  await enqueue(agent, { to: agent, from: 'cto', subject: 's', body: 'edge', ts: new Date().toISOString() });
  await rawPool.query('UPDATE agentstate_queue SET dequeue_count = 3 WHERE queue = $1', [queueName(agent)]);
  assert.equal((await readMessages(agent, { ack: false, maxDeliveries: 3 })).length, 1, 'exactly at the limit is still live');
  await rawPool.query('UPDATE agentstate_queue SET dequeue_count = 4 WHERE queue = $1', [queueName(agent)]);
  assert.equal((await readMessages(agent, { ack: false, maxDeliveries: 3 })).length, 0, 'one over the limit is dead-lettered');
  assert.equal((await readMessages(agent, { deadLetter: true, maxDeliveries: 3 })).length, 1);
});

test('dead letter: a message older than the max age is retired even when its TTL is longer', async () => {
  const agent = uniqueAgent('dlq-age');
  const ts = new Date().toISOString();
  await enqueue(agent, { to: agent, from: 'cto', subject: 'old', body: 'old', ts }, 30 * 24 * 3600); // TTL far in the future
  await enqueue(agent, { to: agent, from: 'cto', subject: 'fresh', body: 'fresh', ts });
  await rawPool.query(`UPDATE agentstate_queue SET enqueued_at = now() - interval '8 days' WHERE queue = $1 AND payload->>'body' = 'old'`, [queueName(agent)]);

  assert.deepEqual((await readMessages(agent, { ack: false })).map((m) => m.body), ['fresh']);
  const audit = await readMessages(agent, { deadLetter: true });
  assert.deepEqual(audit.map((m) => [m.body, m.dead_letter_reason]), [['old', 'expired']]);
  assert.deepEqual((await readMessages(agent, { ack: true })).map((m) => m.body), ['fresh']);
});

test('the dead-letter audit is read-only (ack is ignored) and isolated per agent queue', async () => {
  const agent = uniqueAgent('dlq-audit');
  const other = uniqueAgent('dlq-other');
  await enqueue(agent, { to: agent, from: 'cto', subject: 's', body: 'gone', ts: new Date().toISOString() }, 1);
  await new Promise((r) => setTimeout(r, 1300));

  const first = await readMessages(agent, { deadLetter: true, ack: true });
  const second = await readMessages(agent, { deadLetter: true, ack: true });
  assert.equal(first.length, 1);
  assert.equal(first[0].acked, false);
  assert.deepEqual(second.map((m) => m.message_id), first.map((m) => m.message_id), 'auditing must never consume');
  assert.equal((await readMessages(other, { deadLetter: true })).length, 0, "another agent's audit must not see these");
});

// A real backend failure (connection refused, missing table) must throw rather than resolve to an
// empty-looking result -- this file cannot exercise that itself: src/config/env.ts's loadEnv()
// memoizes process.env on first read, and this file's first read already committed to the real,
// working PG_HOST above. Those two scenarios instead get their own files, each its own
// `node --test` child process with a bad target baked in from the START:
//   queue-postgres-unreachable.test.ts    PG_PORT points at nothing listening
//   queue-postgres-missing-table.test.ts  PG_HOST is real, but the database has no agentstate_queue table
