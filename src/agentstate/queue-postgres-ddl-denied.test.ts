// SAFETY: a DB role that CANNOT create the table must FAIL LOUDLY, never read as an empty inbox.
//
// This is the invariant the original "missing table throws" tests existed to protect, relocated
// after self-provisioning landed (see queue-postgres-missing-table.test.ts's header for why a
// missing table is now provisioned rather than refused). Self-provisioning moved the failure
// boundary; it did not remove it. `CREATE TABLE IF NOT EXISTS` can still be denied, and the one
// thing that denial must never do is surface as "you have no messages" -- an agent that silently
// stops receiving dispatches is indistinguishable from an agent nobody is talking to, which is
// exactly the class of defect this subsystem's module docs are written against.
//
// WHY ITS OWN FILE, AND WHY THAT IS NOT OPTIONAL. `loadEnv()` (src/config/env.ts) memoizes into a
// module-level `cached` and exports no reset. So PG_USER is read exactly ONCE per process, at the
// first loadEnv() call, and any later `process.env.PG_USER = ...` is written to an environment
// nothing will read again. An earlier draft of this test lived at the bottom of the missing-table
// file and flipped PG_USER in-place; the two tests above it had already materialized the cache as
// the `postgres` superuser, so the "restricted" call ran AS THE SUPERUSER, created the table
// happily, and resolved to []. The assertion then failed for the right reason and the wrong cause:
// the test was not exercising a denied role at all. Splitting the file is what makes the identity
// real, and is the same convention queue-postgres-unreachable.test.ts already uses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const DB = 'agentstate_test_ddl_denied';
const ROLE = 'agentstate_nodll';

// Set BEFORE the first loadEnv() -- this is the whole point of the file (see header).
process.env.STATE_BACKEND = 'postgres';
process.env.PG_HOST = '127.0.0.1';
process.env.PG_PORT = '5432';
process.env.PG_DATABASE = DB;
process.env.PG_USER = ROLE;
process.env.PG_PASSWORD = 'postgres';
process.env.PG_SSL_VERIFY = 'false';

const { readMessages, enqueue, resetPoolForTests } = await import('./queue-postgres.js');

/** Admin connection. Deliberately constructed from literals rather than loadEnv(), so the setup
 *  path cannot be affected by the restricted identity this file installs above. */
function adminPool(database: string): pg.Pool {
  return new pg.Pool({ host: '127.0.0.1', port: 5432, database, user: 'postgres', password: 'postgres' });
}

before(async () => {
  const maint = adminPool('postgres');
  await maint
    .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB])
    .catch(() => undefined);
  await maint.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => undefined);
  await maint.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await maint.query(`CREATE DATABASE "${DB}"`);
  await maint.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'postgres'`);
  await maint.end();

  const db = adminPool(DB);
  // Postgres 15+ already withholds CREATE on schema public from PUBLIC; the explicit REVOKE keeps
  // this test honest on a 13/14 instance too, where PUBLIC would otherwise carry it implicitly.
  await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await db.query(`REVOKE CREATE ON SCHEMA public FROM ${ROLE}`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await db.end();
});

after(async () => {
  await resetPoolForTests();
  const maint = adminPool('postgres');
  await maint
    .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB])
    .catch(() => undefined);
  await maint.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => undefined);
  await maint.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await maint.end();
});

test('readMessages under a DDL-denied role THROWS, never resolves to an empty inbox', async () => {
  await assert.rejects(
    () => readMessages('cfo', { max: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof Error, 'a real Error must reach the caller');
      assert.match(e.message, /permission denied/i, `expected a permission error, got: ${e.message}`);
      return true;
    },
    'a role that cannot provision the table must fail loudly, not report "no messages"',
  );
});

test('enqueue under a DDL-denied role THROWS too, so a send cannot be silently dropped', async () => {
  await assert.rejects(
    () => enqueue('cfo', { from: 'cto', kind: 'note', body: 'must not vanish' }),
    (e: unknown) => e instanceof Error && /permission denied/i.test(e.message),
    'a dispatch that cannot be persisted must surface, not report success',
  );
});

test('COUNTERFACTUAL: the SAME role succeeds once granted CREATE', async () => {
  // Without this, the two tests above would still pass if the role could not log in at all, or if
  // the database were missing -- any error matching /permission denied/ would satisfy them for the
  // wrong reason. Granting CREATE to the very same identity and watching the same call succeed is
  // what proves the denial was the DDL specifically, and that this file is testing what it claims.
  const db = adminPool(DB);
  await db.query(`GRANT CREATE ON SCHEMA public TO ${ROLE}`);
  await db.end();

  await resetPoolForTests();
  await enqueue('cfo', { from: 'cto', kind: 'note', body: 'now provisioned' });
  const got = await readMessages('cfo', { max: 5 });
  assert.equal(got.length, 1, 'with CREATE granted, the same role must provision and deliver');
  assert.equal(got[0].body, 'now provisioned');
});
