import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  revokeToken,
  isRevoked,
  getRevocationState,
  clearRevocation,
  loadRevocations,
} from './revocation-store.js';

// revocation-store lazily calls loadEnv() (via cosmosConfigured()), which validates the WHOLE env.
// Seed the unrelated required vars first (same pattern as oauth-tokens.test.ts). With COSMOS_* unset,
// isConfigured() is false and the store runs purely in-memory -- exactly the local/dev fallback these
// hermetic tests pin. The Cosmos-backed durability is covered by the live post-deploy smoke test.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

beforeEach(async () => {
  await clearRevocation();
});

test('revoking a token rejects it and leaves others alone', async () => {
  await revokeToken('leaked-token-A', 'leaked in a commit');
  assert.equal(isRevoked('leaked-token-A'), true, 'the revoked token must be rejected');
  assert.equal(isRevoked('some-other-token'), false, 'an unrelated token must be unaffected');
});

test('REGRESSION: revoking a SECOND token keeps the first revoked (old single-slot bug)', async () => {
  await revokeToken('token-A', 'first leak');
  await revokeToken('token-B', 'second leak');
  // The original store held ONE hash, so revoking B silently un-revoked A. The set-based store must not.
  assert.equal(isRevoked('token-A'), true, 'token-A must STILL be revoked after token-B is revoked');
  assert.equal(isRevoked('token-B'), true, 'token-B must be revoked');
});

test('getRevocationState reflects the most recent revocation (health/admin back-compat)', async () => {
  await revokeToken('token-A', 'first');
  const s = await revokeToken('token-B', 'second');
  const state = getRevocationState();
  assert.equal(state.revoked_token_hash, s.revoked_token_hash, 'latest hash surfaces for /health');
  assert.equal(state.revoked_reason, 'second');
  assert.ok(state.revoked_at, 'revoked_at is set');
});

test('clearRevocation removes every revocation', async () => {
  await revokeToken('token-A', 'x');
  await revokeToken('token-B', 'y');
  await clearRevocation();
  assert.equal(isRevoked('token-A'), false);
  assert.equal(isRevoked('token-B'), false);
  assert.equal(getRevocationState().revoked_token_hash, null);
});

test('loadRevocations is safe (fail-open) with no Cosmos configured', async () => {
  const n = await loadRevocations();
  assert.equal(typeof n, 'number', 'returns a count, never throws');
});

test('isRevoked short-circuits cheaply when nothing is revoked', () => {
  assert.equal(isRevoked('anything'), false);
});
