import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { verifyDescopeToken, type DescopeClaims } from './descope.js';

/**
 * Configured-path coverage for verifyDescopeToken's telemetry instrumentation (gw_descope_auth,
 * ADR-002 trigger 4 -- see descope.ts's TELEMETRY doc comment on verifyDescopeToken).
 *
 * WHY THIS IS A SEPARATE FILE from descope.test.ts (2026-07-30 review): descope.test.ts's own
 * verifyDescopeToken test deliberately leaves DESCOPE_PROJECT_ID unset to pin the "inert unless
 * configured" fast path -- and config/env.ts's loadEnv() caches its parsed result ONCE for the life
 * of the process. node:test runs each matched test FILE in its own child process by default, so a
 * separate file gets its own fresh env cache: this file's before() hook sets DESCOPE_PROJECT_ID (and
 * POSTHOG_GATEWAYOPS_KEY, so captureGatewayEvent actually attempts the fire-and-forget POST instead
 * of no-op'ing) before anything in this file ever calls loadEnv(), without touching or conflicting
 * with descope.test.ts's unconfigured-path assertion in its own process.
 *
 * Before this file existed, NOTHING exercised verifyDescopeToken's configured path at all -- the
 * core instrumentation this PR ships (the event name, the outcome classification, the latency field)
 * could have been deleted or silently broken and the suite would have stayed green.
 *
 * Hermetic: stubs globalThis.fetch (this repo's established pattern -- see auto-guard.test.ts,
 * deep-health.test.ts, fetch-budget.test.ts) rather than touching real Descope or PostHog. Routes on
 * URL: a JWKS-endpoint request serves a locally-generated RSA public key; a PostHog ingest request
 * (`/i/v0/e/`) is captured into an array instead of actually sent, so the event shape (name,
 * `outcome`, `latency_ms`) is directly assertable. captureGatewayEvent's fetch call is fire-and-forget
 * (never awaited by its caller) but is still invoked, and its body read, SYNCHRONOUSLY before
 * verifyDescopeToken's own `await` chain resolves -- so by the time `await verifyDescopeToken(...)`
 * returns in a test below, the capture has already landed in `captured`.
 *
 * TEST ORDER MATTERS (documented, not hidden): descope.ts's JWKS cache is a module-scoped singleton
 * (`jwksCache`), shared across every test in THIS file's process. The 'jwks_unavailable' test runs
 * FIRST, before any successful fetch ever populates that cache for this file's DESCOPE_PROJECT_ID --
 * that is what makes a simulated fetch failure genuinely uncached (infraFailure: true) rather than
 * falling back to an already-warm cache from an earlier test.
 */
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
  // Force-set, NOT `??=` (reviewer-caught, 2026-07-30, same class of bug as descope.test.ts's own
  // fix): this file's tests are only hermetic if DESCOPE_PROJECT_ID and POSTHOG_GATEWAYOPS_KEY
  // ACTUALLY equal the hardcoded PROJECT_ID/stub values below -- `??=` would silently keep an
  // inherited, DIFFERENT value, which could route the JWKS request to a real, unstubbed URL (the
  // installFetchStub router below throws on any unrecognized URL, so this would likely fail loudly
  // rather than pass for the wrong reason, but "likely" is not the same guarantee as `descope.test
  // .ts`'s explicit unconfigured-path assertion gets from its own force-clear).
  process.env.DESCOPE_PROJECT_ID = 'Ptest000000000000000000000000';
  process.env.POSTHOG_GATEWAYOPS_KEY = 'phc_test_gatewayops_key';
});

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-telemetry-1';
const PROJECT_ID = 'Ptest000000000000000000000000';
const ISSUER = `https://api.descope.com/v1/apps/${PROJECT_ID}`;
const JWKS_URL = `https://api.descope.com/${PROJECT_ID}/.well-known/jwks.json`;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signRs256(claims: DescopeClaims, kid = KID, key: KeyObject = privateKey): string {
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

/** A real JWKS response body containing the test RSA public key, in the shape fetchJwks() expects. */
function jwksResponseBody(): string {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return JSON.stringify({ keys: [{ ...jwk, kid: KID }] });
}

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

/** Installs a fetch stub routing on URL: JWKS requests use `jwksBehavior`, PostHog ingest requests
 * (`/i/v0/e/`) are captured (never actually sent) into the returned array. Any other URL throws,
 * so an unexpected network call fails the test loudly instead of hanging or silently no-op'ing.
 * Returns a restore() to put the real fetch back -- callers MUST call it in a finally block. */
function installFetchStub(jwksBehavior: () => Response | Promise<Response>): { captured: CapturedPost[]; restore: () => void } {
  const original = globalThis.fetch;
  const captured: CapturedPost[] = [];
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u === JWKS_URL) return Promise.resolve(jwksBehavior());
    if (u.includes('/i/v0/e/')) {
      captured.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    throw new Error(`unexpected fetch to ${u} in this hermetic test`);
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = original; } };
}

test('jwks_unavailable: a JWKS fetch failure with no prior cache is classified as an infra failure, not credential_rejected -- MUST run before any test that successfully populates the cache', async () => {
  const { captured, restore } = installFetchStub(() => {
    throw new Error('simulated network failure');
  });
  try {
    const claims = await verifyDescopeToken(signRs256(baseClaims()));
    assert.equal(claims, null, 'a JWKS outage must still fail closed (null claims), never throw');
  } finally {
    restore();
  }
  assert.equal(captured.length, 1, 'exactly one gw_descope_auth capture attempt');
  const [event] = captured;
  assert.equal(event.body.event, 'gw_descope_auth');
  assert.equal((event.body.properties as Record<string, unknown>).outcome, 'jwks_unavailable');
  const latency = (event.body.properties as Record<string, unknown>).latency_ms;
  assert.equal(typeof latency, 'number');
  assert.ok((latency as number) >= 0);
});

test('credential_rejected: a real, reachable JWKS with a genuinely bad credential (expired) is classified as credential_rejected, not jwks_unavailable', async () => {
  const { captured, restore } = installFetchStub(() => new Response(jwksResponseBody(), { status: 200 }));
  try {
    const expired = signRs256(baseClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    const claims = await verifyDescopeToken(expired);
    assert.equal(claims, null, 'an expired token must be rejected');
  } finally {
    restore();
  }
  assert.equal(captured.length, 1);
  assert.equal((captured[0].body.properties as Record<string, unknown>).outcome, 'credential_rejected');
});

test('verified: a genuinely valid token against a reachable JWKS is classified as verified, and the claims are returned', async () => {
  const { captured, restore } = installFetchStub(() => new Response(jwksResponseBody(), { status: 200 }));
  try {
    const claims = await verifyDescopeToken(signRs256(baseClaims()));
    assert.ok(claims, 'a validly-signed, unexpired, correctly-issued token must verify');
    assert.equal(claims!.lane, 'clo');
  } finally {
    restore();
  }
  assert.equal(captured.length, 1);
  const props = captured[0].body.properties as Record<string, unknown>;
  assert.equal(props.outcome, 'verified');
  assert.equal(typeof props.latency_ms, 'number');
  // Never leaks the token or any claim content into telemetry -- only outcome + timing (plus the
  // fixed 'source' tag buildCapturePayload stamps onto every gateway-ops event).
  assert.equal(Object.keys(props).sort().join(','), 'latency_ms,outcome,source');
});

test('a malformed token (not 3 JWT segments) is credential_rejected without ever touching the network', async () => {
  const { captured, restore } = installFetchStub(() => {
    throw new Error('must not fetch JWKS for a token that is not even JWT-shaped');
  });
  try {
    const claims = await verifyDescopeToken('not-a-jwt-at-all');
    assert.equal(claims, null);
  } finally {
    restore();
  }
  assert.equal(captured.length, 1);
  assert.equal((captured[0].body.properties as Record<string, unknown>).outcome, 'credential_rejected');
});
