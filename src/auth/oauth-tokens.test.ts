import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createAuthCode,
  consumeAuthCode,
  verifyPkceS256,
  signToken,
  verifyToken,
} from './oauth-tokens.js';

// The auth-code store lazily calls loadEnv() (to check whether Cosmos is configured), which
// validates the whole env. With COSMOS_* unset the store uses its in-memory fallback, which is
// exactly what these hermetic tests exercise. Satisfy the unrelated required vars first.
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

// These run with COSMOS_ENDPOINT/KEY unset, so they exercise the in-memory fallback path.
// The Cosmos-backed path shares the exact same contract (single-use, expiry-checked); it is
// covered by the live smoke test, not here, because unit tests must stay hermetic.

const baseRec = {
  clientId: 'client-abc',
  redirectUri: 'https://claude.ai/cb',
  scope: 'mcp',
  codeChallenge: 'x'.repeat(43),
  codeChallengeMethod: 'S256' as const,
};

test('auth code round-trips and returns the stored record', async () => {
  const code = await createAuthCode(baseRec);
  assert.match(code, /^[0-9a-f]{64}$/); // 32 random bytes hex
  const rec = await consumeAuthCode(code);
  assert.ok(rec);
  assert.equal(rec?.clientId, 'client-abc');
  assert.equal(rec?.redirectUri, 'https://claude.ai/cb');
  assert.equal(rec?.codeChallengeMethod, 'S256');
});

test('auth code is single-use: a second consume returns null', async () => {
  const code = await createAuthCode(baseRec);
  assert.ok(await consumeAuthCode(code));
  assert.equal(await consumeAuthCode(code), null);
});

test('an expired auth code returns null', async () => {
  const code = await createAuthCode(baseRec, -1); // already expired
  assert.equal(await consumeAuthCode(code), null);
});

test('consuming an unknown / malformed code returns null (never throws)', async () => {
  assert.equal(await consumeAuthCode('does-not-exist'), null);
  assert.equal(await consumeAuthCode('../colls/other/docs/x'), null);
});

test('verifyPkceS256 accepts the matching verifier and rejects a wrong one', () => {
  // challenge = base64url(sha256(verifier))
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256('wrong-verifier', challenge), false);
});

test('access token verifies and a tampered token does not', () => {
  const secret = 'unit-test-secret';
  const now = Math.floor(Date.now() / 1000);
  const tok = signToken(
    { iss: 'https://mcp.otchealth.app', aud: 'otchealth-mcp', sub: 'client-abc', scope: 'mcp', typ: 'access', exp: now + 60 },
    secret,
  );
  assert.ok(verifyToken(tok, secret));
  assert.equal(verifyToken(tok + 'x', secret), null);
  assert.equal(verifyToken(tok, 'wrong-secret'), null);
});
