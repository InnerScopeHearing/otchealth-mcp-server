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

const { isConfigured, ensureQueue, enqueue, readMessages, resetPoolForTests } = await import('./queue-postgres.js');
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

test('ensureQueue resolves without throwing when configured (no-op: no per-agent object to create)', async () => {
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

test('PEEK (ack=false): does NOT consume -- the message is still there for a later drain', async () => {
  const agent = uniqueAgent('peek');
  await enqueue(agent, { to: agent, from: 'cto', subject: 'peek-me', body: 'peek body', ts: new Date().toISOString() });

  const peeked = await readMessages(agent, { max: 8, ack: false, visibilitySec: 1 });
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0].acked, false);
  assert.equal(peeked[0].dequeue_count, 1, 'a peek is still a fetch, so dequeue_count must increment');

  // Immediately re-peeking must NOT see it again -- it is hidden until the visibility window
  // passes, exactly like Azure's visibilitytimeout.
  const immediateRepeek = await readMessages(agent, { max: 8, ack: false, visibilitySec: 1 });
  assert.equal(immediateRepeek.length, 0, 'a just-peeked message must be hidden during its visibility window');

  await new Promise((r) => setTimeout(r, 1300)); // let the 1s visibility window lapse

  // A DRAIN after the window passes must still find the SAME message -- proof peek never deleted it.
  const drained = await readMessages(agent, { max: 8, ack: true });
  assert.equal(drained.length, 1);
  assert.equal(drained[0].message_id, peeked[0].message_id, 'must be the identical message, not a new one');
  assert.equal(drained[0].dequeue_count, 2, 'second fetch (the drain) increments dequeue_count again');

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

test('two concurrent PEEKS never double-claim (same FOR UPDATE SKIP LOCKED path, non-destructive)', async () => {
  const agent = uniqueAgent('peekrace');
  const TOTAL = 10;
  for (let i = 0; i < TOTAL; i++) {
    await enqueue(agent, { to: agent, from: 'cto', subject: `p${i}`, body: `pbody-${i}`, ts: new Date().toISOString() });
  }

  const results = await Promise.all([
    readMessages(agent, { max: 32, ack: false, visibilitySec: 5 }),
    readMessages(agent, { max: 32, ack: false, visibilitySec: 5 }),
  ]);
  const allIds = results.flatMap((r) => r.map((m) => m.message_id));
  assert.equal(allIds.length, TOTAL, 'both peeks together must see each message exactly once, not twice');
  assert.equal(new Set(allIds).size, TOTAL);

  // And nothing was deleted: after the window, a drain must find all 10 still there.
  await new Promise((r) => setTimeout(r, 5300));
  const drained = await readMessages(agent, { max: 32, ack: true });
  assert.equal(drained.length, TOTAL, 'peeking must never consume messages, even under concurrency');
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
});

test('the agent id is validated/normalized (invalid ids are rejected, not silently accepted)', async () => {
  await assert.rejects(() => enqueue('not a valid id!', { to: 'x', from: 'cto', subject: 's', body: 'b', ts: '' }));
  await assert.rejects(() => readMessages('not a valid id!'));
});

// A real backend failure (connection refused, missing table) must throw rather than resolve to an
// empty-looking result -- this file cannot exercise that itself: src/config/env.ts's loadEnv()
// memoizes process.env on first read, and this file's first read already committed to the real,
// working PG_HOST above. Those two scenarios instead get their own files, each its own
// `node --test` child process with a bad target baked in from the START:
//   queue-postgres-unreachable.test.ts    PG_PORT points at nothing listening
//   queue-postgres-missing-table.test.ts  PG_HOST is real, but the database has no agentstate_queue table
