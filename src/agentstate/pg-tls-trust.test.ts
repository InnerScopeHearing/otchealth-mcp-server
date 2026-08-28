import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * PG TLS verification (2026-08-28). Ported from flatstick/packages/api/src/db-tls-trust.test.ts,
 * which proves the identical fix in production against the same RDS CA family.
 *
 * RDS terminates TLS with an Amazon-issued cert; Node has no reason to already trust it, and the
 * verification-off default (env.ts's PG_SSL_VERIFY, previously 'false') existed only because the
 * trust store was not yet baked into the image. The fix is the Dockerfile's RDS CA bundle +
 * NODE_EXTRA_CA_CERTS (APPENDS to Node's default roots, so nothing else changes) plus flipping the
 * default to 'true' now that the bundle exists. These assertions exist because the Dockerfile half
 * of that fix is invisible to every other test in this suite -- nothing here builds the image or
 * opens a TLS connection to RDS, so deleting the two Dockerfile lines would go unnoticed until a
 * deploy failed with encrypted-but-unverified connections, or (worse, if the default were also
 * reverted) a silent return to no verification at all.
 *
 * The second half guards the tempting wrong fix: relaxing rejectUnauthorized to a hardcoded false
 * (or leaving PG_SSL_VERIFY defaulted false forever) makes every deploy "work" by accepting ANY
 * certificate, trading away MITM protection for a green tick. Fix the trust store, not the
 * verification -- see env.ts's own PG_SSL_VERIFY comment for the identical instruction to a human
 * reader who might reach for that shortcut during an incident.
 */

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

test('the image bakes in the Amazon RDS CA bundle', () => {
  assert.match(
    dockerfile,
    /ADD\s+https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem\s+\S+/,
  );
});

test('NODE_EXTRA_CA_CERTS points Node at the SAME path the bundle was actually written to', () => {
  // A mismatch here is silent: Node ignores a nonexistent NODE_EXTRA_CA_CERTS path without warning,
  // so the image would look correct (build succeeds, no error anywhere) and still fail every
  // database connection once PG_SSL_VERIFY=true tries to verify against a CA Node was never told
  // to trust.
  const envLine = dockerfile.match(/ENV\s+NODE_EXTRA_CA_CERTS=(\S+)/);
  assert.ok(envLine, 'NODE_EXTRA_CA_CERTS is not set in the Dockerfile');
  const addLine = dockerfile.match(
    /ADD\s+https:\/\/truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem\s+(\S+)/,
  );
  assert.ok(addLine, 'the RDS bundle ADD instruction is missing');
  assert.equal(envLine![1], addLine![1]);
});

test('PG_SSL_VERIFY defaults to true, now that the trust store is baked in', () => {
  const envSource = readFileSync(new URL('../config/env.ts', import.meta.url), 'utf8');
  const field = envSource.match(/PG_SSL_VERIFY:\s*z\s*\n\s*\.enum\(\['true', 'false'\]\)\s*\n\s*\.default\('(\w+)'\)/);
  assert.ok(field, 'could not find the PG_SSL_VERIFY schema field in env.ts (has its shape changed?)');
  assert.equal(field![1], 'true');
});

test('both Postgres pools actually WIRE PG_SSL_VERIFY into rejectUnauthorized, verification is not a dead flag', () => {
  // Proves the fix end to end: the Dockerfile bakes the trust, the schema default turns
  // verification on, and the pool config genuinely consumes the flag rather than hardcoding
  // either side (a hardcoded `rejectUnauthorized: true` with no flag would break every
  // CI run against the runner's snakeoil Postgres; a hardcoded `false` would silently disable
  // verification regardless of what the schema says).
  for (const relative of ['./postgres.ts', './queue-postgres.ts']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(
      source,
      /ssl:\s*\{\s*rejectUnauthorized:\s*env\.PG_SSL_VERIFY\s*\}/,
      `${relative} must read PG_SSL_VERIFY into rejectUnauthorized, not hardcode either value`,
    );
    // `ssl: 'require'` (or similar) would encrypt while accepting any cert -- the exact trap
    // Flatstick's own version of this test guards against.
    assert.doesNotMatch(source, /ssl:\s*['"]require['"]/);
  }
});
