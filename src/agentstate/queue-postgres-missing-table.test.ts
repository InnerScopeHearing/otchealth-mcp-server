// A reachable Postgres with NO agentstate_queue table must PROVISION it and work (2026-08-18, CTO
// review). The original design provisioned "out of band" and threw here. That was changed
// deliberately, because this repo has NO committed migration mechanism -- no .sql files, no
// scripts/migrate*, no DDL in Terraform; the existing agentstate_* tables were applied by hand and
// never captured in git -- while the dispatcher selects on STATE_BACKEND, which is ALREADY
// `postgres` in production. Shipping a throw-on-missing-table would therefore have armed a
// fleet-wide break of agent_dispatch / inbox_read / wake's inbox peek at the next deploy, waiting
// on a manual step this codebase has already demonstrated it does not remember.
//
// The safety property the original tests protected is NOT abandoned, it is relocated: a missing
// table is no longer a failure (it is provisioned), but a failure that REMAINS a failure -- the DB
// role lacking DDL rights -- must still surface loudly and must never look like an empty inbox.
// That is pinned by queue-postgres-ddl-denied.test.ts, which is a SEPARATE file because
// loadEnv() memoizes PG_USER on first call and cannot be re-pointed at a restricted role
// once these tests have connected as the superuser.
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

test('a reachable DB with NO table is PROVISIONED on first use, not refused', async () => {
  const q = await import('./queue-postgres.js');
  await q.enqueue('cfo', { from: 'cto', kind: 'note', body: 'provisioned on demand' });
  const got = await q.readMessages('cfo', { max: 5 });
  assert.equal(got.length, 1, 'the message must survive the provisioning round trip');
  // And the table really exists now, not just "the call did not throw".
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ host: '127.0.0.1', port: 5432, database: DB, user: 'postgres', password: process.env.PG_PASSWORD });
  const r = await admin.query("SELECT to_regclass('agentstate_queue') AS t");
  await admin.end();
  assert.equal(r.rows[0].t, 'agentstate_queue');
});

test('provisioning is idempotent across repeated calls and concurrent callers', async () => {
  const q = await import('./queue-postgres.js');
  // Two concurrent first-uses race CREATE TABLE IF NOT EXISTS; both must succeed.
  await Promise.all([
    q.enqueue('cto', { from: 'cfo', kind: 'note', body: 'a' }),
    q.enqueue('cto', { from: 'cfo', kind: 'note', body: 'b' }),
  ]);
  const got = await q.readMessages('cto', { max: 10 });
  assert.equal(got.length, 2, 'neither concurrent enqueue may be lost to a provisioning race');
});
