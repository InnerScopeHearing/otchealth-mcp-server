import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { verifyDescopeClaims, laneFromScope, type DescopeClaims } from './descope.js';

// loadEnv() (called transitively by laneFromScope -> scopeLaneMap) caches its result for the
// life of the process, so DESCOPE_SCOPE_LANE_MAP is deliberately left UNSET here -- these tests
// exercise the built-in DEFAULT_SCOPE_LANE_MAP, which is exactly what's live in production today
// (the 3 real Inbound App Clients provisioned 2026-07-08). Satisfy the unrelated required env
// vars first, same pattern as oauth-tokens.test.ts's before() hook.
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

// Hermetic: generates its own RSA keypair and self-signs test JWTs. No network, no real
// Descope project touched -- mirrors this repo's convention of not unit-testing network-bound
// paths (see oauth-tokens.test.ts's comment on the Cosmos-backed auth-code store).

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const ISSUER = 'https://api.descope.com/v1/apps/Ptest000000000000000000000000';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signRs256(claims: DescopeClaims, kid = KID, key: KeyObject = createPrivateKey(privateKey)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = cryptoSign('RSA-SHA256', Buffer.from(data), key);
  return `${data}.${b64url(sig)}`;
}

function baseClaims(overrides: Partial<DescopeClaims> = {}): DescopeClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: 'K_test_access_key',
    exp: now + 300,
    lane: 'clo',
    ring: 'exec-pilot',
    pilot: true,
    ...overrides,
  };
}

function keySet(): Map<string, KeyObject> {
  return new Map([[KID, publicKey]]);
}

test('verifyDescopeClaims accepts a validly-signed, unexpired, correctly-issued token', () => {
  const token = signRs256(baseClaims());
  const claims = verifyDescopeClaims(token, keySet(), ISSUER);
  assert.ok(claims);
  assert.equal(claims?.lane, 'clo');
  assert.equal(claims?.ring, 'exec-pilot');
});

test('verifyDescopeClaims rejects a tampered payload (signature mismatch)', () => {
  const token = signRs256(baseClaims());
  const parts = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify(baseClaims({ lane: 'cfo' }))).toString('base64url');
  const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
  assert.equal(verifyDescopeClaims(tampered, keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects an expired token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRs256(baseClaims({ exp: now - 10 }));
  assert.equal(verifyDescopeClaims(token, keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects a mismatched issuer', () => {
  const token = signRs256(baseClaims({ iss: 'https://api.descope.com/v1/apps/SomeOtherProject' }));
  assert.equal(verifyDescopeClaims(token, keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects an unknown kid (not in the resolved key set)', () => {
  const token = signRs256(baseClaims(), 'unknown-kid');
  assert.equal(verifyDescopeClaims(token, keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects a non-RS256 header', () => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }));
  const payload = b64url(JSON.stringify(baseClaims()));
  const token = `${header}.${payload}.deadbeef`;
  assert.equal(verifyDescopeClaims(token, keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects a malformed token (wrong number of segments)', () => {
  assert.equal(verifyDescopeClaims('not.a.valid.jwt.at.all', keySet(), ISSUER), null);
  assert.equal(verifyDescopeClaims('onlyonepart', keySet(), ISSUER), null);
});

test('verifyDescopeClaims rejects unparseable base64/JSON without throwing', () => {
  assert.equal(verifyDescopeClaims('not-base64!.also-not!.sig', keySet(), ISSUER), null);
});

// -- Scope-based lane resolution (Inbound App Client tokens, 2026-07-08 addition) --------------
// agentFromDescopeToken() itself calls loadEnv()/verifyDescopeToken() (network + env-dependent),
// so per this repo's hermetic-test convention we exercise the pure claim shape here instead:
// verifyDescopeClaims() already proves signature/issuer/expiry verification works identically
// regardless of which claims the payload carries (lane vs scope) -- these tests confirm a
// scope-only payload (no `lane` claim at all, matching a real Inbound App Client token) verifies
// successfully and carries the scope through unchanged, which is everything agentFromDescopeToken
// needs from this layer before it does its own scope->lane mapping.

test('verifyDescopeClaims accepts a scope-only payload with no lane claim (Inbound App Client shape)', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRs256({
    iss: ISSUER,
    sub: 'client-abc',
    exp: now + 600,
    scope: 'mcp:legal.read',
  });
  const claims = verifyDescopeClaims(token, keySet(), ISSUER);
  assert.ok(claims);
  assert.equal(claims?.lane, undefined);
  assert.equal(claims?.scope, 'mcp:legal.read');
});

test('verifyDescopeClaims carries a multi-scope string through unchanged for later mapping', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = signRs256({
    iss: ISSUER,
    sub: 'client-abc',
    exp: now + 600,
    scope: 'mcp:legal.read mcp:legal.personal.read',
  });
  const claims = verifyDescopeClaims(token, keySet(), ISSUER);
  assert.ok(claims);
  assert.equal(claims?.scope, 'mcp:legal.read mcp:legal.personal.read');
});

// -- laneFromScope() direct unit tests, against the built-in DEFAULT_SCOPE_LANE_MAP -----------
// (the 3 real Inbound App Client scopes live in production as of 2026-07-08: mcp:legal.read ->
// clo, mcp:legal.personal.read -> clo-personal, mcp:infra.admin -> cto.)

test('laneFromScope maps a single known scope to its lane', () => {
  assert.equal(laneFromScope('mcp:legal.read'), 'clo');
  assert.equal(laneFromScope('mcp:legal.personal.read'), 'clo-personal');
  assert.equal(laneFromScope('mcp:infra.admin'), 'cto');
});

test('laneFromScope handles a space-separated multi-scope string that maps to the SAME lane', () => {
  // A hypothetical Client granted two scopes that both belong to the clo lane -- not ambiguous,
  // since they resolve to one distinct lane.
  assert.equal(laneFromScope('mcp:legal.read mcp:legal.read'), 'clo');
});

test('laneFromScope rejects (returns null) scopes mapping to MORE THAN ONE distinct lane', () => {
  // A Client somehow granted scopes for two different lanes must not let the token holder pick
  // its own privilege level -- this must be rejected outright, never resolved to either lane.
  assert.equal(laneFromScope('mcp:legal.read mcp:infra.admin'), null);
  assert.equal(laneFromScope('mcp:legal.personal.read mcp:infra.admin'), null);
});

test('laneFromScope returns null for an unmapped/unknown scope', () => {
  assert.equal(laneFromScope('mcp:unknown.scope'), null);
});

test('laneFromScope returns null for empty, whitespace-only, or non-string scope values', () => {
  assert.equal(laneFromScope(''), null);
  assert.equal(laneFromScope('   '), null);
  assert.equal(laneFromScope(undefined), null);
  assert.equal(laneFromScope(null), null);
  assert.equal(laneFromScope(42), null);
});

test('laneFromScope: a known scope alongside an unmapped scope still resolves cleanly', () => {
  // The unmapped scope is simply ignored (filtered out before the ambiguity check), not treated
  // as a second distinct lane.
  assert.equal(laneFromScope('mcp:legal.read mcp:unknown.scope'), 'clo');
});
