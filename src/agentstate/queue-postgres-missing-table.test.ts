// A reachable Postgres with the WRONG (or not-yet-provisioned) schema must also throw, never
// resolve to an empty-looking result -- the "provisioned out of band" design in queue-postgres.ts
// means a database that is up but hasn't had the migration run against it is a real, distinct
// failure mode from "no messages", and this pins that it surfaces as one.
//
// Own file (own `node --test` child process) for the same loadEnv()-memoization reason as
// queue-postgres.test.ts / queue-postgres-unreachable.test.ts: this one points PG_DATABASE at a
// real, reachable database that deliberately has no agentstate_queue table.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const DB = 'agentstate_test_no_queue_table';

process.env.STATE_BACKEND = 'postgres';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = DB;
process.env.PG_USER = 'postgres';
process.env.PG_PASSWORD = 'postgres';
process.env.PG_SSL_VERIFY = 'false';

const { readMessages, enqueue, resetPoolForTests } = await import('./queue-postgres.js');
const pg = (await import('pg')).default;

before(async () => {
  // Connect to the maintenance DB to create/reset a sibling database with NO agentstate_queue
  // table -- a live stand-in for "the migration has not been run against this instance yet".
  const admin = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres', ssl: { rejectUnauthorized: false } });
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(DB).slice(1, -1)}`).catch(() => undefined);
  await admin.query(`CREATE DATABASE "${DB}"`);
  await admin.end();
});

after(async () => {
  await resetPoolForTests();
  const admin = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres', ssl: { rejectUnauthorized: false } });
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => undefined);
  await admin.end();
});

test('readMessages against a reachable DB with no agentstate_queue table THROWS, never resolves to []', async () => {
  await assert.rejects(
    () => readMessages('cto', { max: 8, ack: true }),
    (err: Error) => {
      assert.ok(err instanceof Error);
      assert.ok(/relation .*agentstate_queue.* does not exist/i.test(err.message), `expected a missing-relation error, got: ${err.message}`);
      return true;
    },
  );
});

test('readMessages (peek mode) against a missing table also THROWS', async () => {
  await assert.rejects(() => readMessages('cto', { max: 8, ack: false }));
});

test('enqueue against a missing table THROWS, never silently no-ops', async () => {
  await assert.rejects(() => enqueue('cto', { to: 'cto', from: 'matt', subject: 's', body: 'b', ts: new Date().toISOString() }));
});
