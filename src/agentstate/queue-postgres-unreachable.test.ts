// A connection failure must throw, never resolve to an empty-looking result. Own file (own
// `node --test` child process) because loadEnv() memoizes process.env on first read, and this
// scenario needs a BAD PG_PORT baked in from that very first read -- see queue-postgres.test.ts's
// header for the full reasoning.
//
// This is the load-bearing requirement the whole task turns on: "an empty inbox and a broken
// inbox must be distinguishable by the caller." A pool.query() against an address nothing is
// listening on rejects with ECONNREFUSED; queue-postgres.ts must let that propagate unmodified.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

process.env.STATE_BACKEND = 'postgres';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '5999'; // nothing listens here
process.env.PG_DATABASE = 'agentstate_test';
process.env.PG_USER = 'postgres';
process.env.PG_PASSWORD = 'postgres';
process.env.PG_SSL_VERIFY = 'false';

const { isConfigured, enqueue, readMessages, ensureQueue, resetPoolForTests } = await import('./queue-postgres.js');

after(async () => {
  await resetPoolForTests();
});

test('isConfigured is still true (PG_HOST is set) -- the failure is a connection failure, not "unconfigured"', () => {
  assert.equal(isConfigured(), true);
});

test('readMessages against an unreachable Postgres THROWS, never resolves to []', async () => {
  await assert.rejects(
    () => readMessages('cto', { max: 8, ack: true }),
    (err: Error) => {
      assert.ok(err instanceof Error, 'must be a real Error, not a swallowed failure');
      assert.ok(/ECONNREFUSED|connect|timeout/i.test(err.message), `expected a connection-shaped error, got: ${err.message}`);
      return true;
    },
  );
});

test('readMessages (peek mode) against an unreachable Postgres also THROWS', async () => {
  await assert.rejects(() => readMessages('cto', { max: 8, ack: false }));
});

test('enqueue against an unreachable Postgres THROWS, never resolves as if it succeeded', async () => {
  await assert.rejects(() => enqueue('cto', { to: 'cto', from: 'matt', subject: 's', body: 'b', ts: new Date().toISOString() }));
});

test('ensureQueue against an unreachable Postgres THROWS -- it must never report "ready" when it is not', async () => {
  // CONTRACT CHANGE, 2026-08-18. This test previously asserted the OPPOSITE (doesNotReject),
  // pinning ensureQueue as a validate-only no-op that never opened a connection. Self-provisioning
  // (queue-postgres.ts's ensureSchema) made ensureQueue actually create the table, so it now
  // connects -- and the old assertion started failing. Three reasons the NEW behaviour is the
  // correct one, rather than something to paper over by relaxing the test:
  //
  //   1. PARITY. This module is a drop-in for queue-azure.ts, whose ensureQueue (queue-azure.ts:51)
  //      PUTs to create the physical queue and throws on any non-201/204. A Postgres ensureQueue
  //      that silently resolves against a dead database is the odd one out, not the faithful one.
  //   2. IT IS THE SAME DEFECT CLASS THIS FILE EXISTS TO PREVENT. A resolved ensureQueue means
  //      "the inbox is ready." Returning that against an unreachable database is a plausible value
  //      returned on failure -- exactly what the header calls the load-bearing requirement.
  //   3. NOTHING REGRESSES. ensureQueue has no caller outside src/agentstate/ (only queue.ts's
  //      dispatcher wrapper), so no hot path gains a throw it did not already have via the
  //      read/write it was about to perform anyway.
  await assert.rejects(
    () => ensureQueue('cto'),
    (err: Error) => {
      assert.ok(err instanceof Error, 'must be a real Error, not a swallowed failure');
      assert.match(err.message, /ECONNREFUSED|connect|timeout/i, `expected a connection-shaped error, got: ${err.message}`);
      return true;
    },
  );
});
