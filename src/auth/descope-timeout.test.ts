import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { verifyDescopeToken } from './descope.js';

const projectId = 'Ptest000000000000000000000000';
const token = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZCJ9.e30.c2ln';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    DESCOPE_PROJECT_ID: projectId,
    POSTHOG_GATEWAYOPS_KEY: 'synthetic-test-key',
  };
  for (const [key, value] of Object.entries(required)) process.env[key] = value;
});

after(() => {
  for (const key of [
    'CIO_SITE_ID', 'CIO_TRACK_KEY', 'CIO_APP_API_BEARER', 'PERPLEXITY_CONNECTOR_TOKEN',
    'ADMIN_REVOKE_TOKEN', 'N8N_WEBHOOK_SECRET', 'DESCOPE_PROJECT_ID', 'POSTHOG_GATEWAYOPS_KEY',
  ]) delete process.env[key];
});

test('Descope cold JWKS body wait is cancelled and auth reports the bounded outage outcome', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  const telemetry: Array<Record<string, unknown>> = [];
  let timeoutMs = 0;
  let bodyCancelled = false;
  let jwksSignal: AbortSignal | undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('api.descope.com')) {
      jwksSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          jwksSignal?.addEventListener('abort', () => {
            bodyCancelled = true;
            reject(jwksSignal.reason);
          }, { once: true });
        }),
      } as Response;
    }
    telemetry.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return { ok: true, status: 200 } as Response;
  };
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (milliseconds: number) => {
      timeoutMs = milliseconds;
      setTimeout(() => controller.abort(new DOMException('synthetic timeout', 'TimeoutError')), 20);
      return controller.signal;
    },
  });

  try {
    const started = Date.now();
    const claims = await verifyDescopeToken(token);
    const elapsedMs = Date.now() - started;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(claims, null, 'an unavailable JWKS must fail closed');
    assert.equal(timeoutMs, 5_000, 'the production fetch deadline is fixed and bounded');
    assert.equal(jwksSignal, controller.signal, 'the deadline signal reaches fetch and body parsing');
    assert.equal(bodyCancelled, true, 'a stalled response body is cancelled by the same deadline');
    assert.ok(elapsedMs < 500, `verification should settle promptly, got ${elapsedMs} ms`);
    const event = telemetry.find((item) => item.event === 'gw_descope_auth');
    assert.ok(event);
    assert.equal((event.properties as Record<string, unknown>).outcome, 'jwks_unavailable');
    assert.ok(Number((event.properties as Record<string, unknown>).latency_ms) < 500);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
  }
});

test('Descope JWKS cache, key rotation, and signature rejection behavior remain intact', async () => {
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let jwks = [
    { ...(first.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'first-kid', kty: 'RSA' },
  ];
  let jwksCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('api.descope.com')) {
      jwksCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { ok: true, status: 200, json: async () => ({ keys: jwks }) } as Response;
    }
    return { ok: true, status: 200 } as Response;
  };

  const signedToken = (kid: string, key: KeyObject) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: `https://api.descope.com/v1/apps/${projectId}`,
      sub: 'synthetic-client',
      exp: Math.floor(Date.now() / 1000) + 300,
      lane: 'clo',
    })).toString('base64url');
    const data = `${header}.${payload}`;
    return `${data}.${cryptoSign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  };

  try {
    assert.equal(await verifyDescopeToken('opaque-static-token'), null);
    assert.equal(jwksCalls, 0, 'non-JWT credentials retain the no-network path');
    const firstToken = signedToken('first-kid', first.privateKey);
    const slowStart = Date.now();
    assert.equal((await verifyDescopeToken(firstToken))?.lane, 'clo');
    const slowElapsedMs = Date.now() - slowStart;
    assert.ok(slowElapsedMs >= 30, 'the synthetic JWKS response exercised a real asynchronous wait');
    assert.ok(slowElapsedMs < 500, `a valid slower response should complete before the deadline, got ${slowElapsedMs} ms`);
    assert.equal(jwksCalls, 1);
    assert.equal((await verifyDescopeToken(firstToken))?.lane, 'clo');
    assert.equal(jwksCalls, 1, 'the warm cache avoids an extra provider request');

    jwks = [
      ...jwks,
      { ...(rotated.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'rotated-kid', kty: 'RSA' },
    ];
    assert.equal((await verifyDescopeToken(signedToken('rotated-kid', rotated.privateKey)))?.lane, 'clo');
    assert.equal(jwksCalls, 2, 'a missing kid triggers one refresh and accepts the rotated signing key');

    const invalid = signedToken('rotated-kid', first.privateKey);
    assert.equal(await verifyDescopeToken(invalid), null, 'a mismatched signature remains rejected');
    assert.equal(jwksCalls, 2, 'a cached key is used to reject an invalid signature without another fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
