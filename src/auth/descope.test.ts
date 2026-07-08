import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { verifyDescopeClaims, type DescopeClaims } from './descope.js';

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
