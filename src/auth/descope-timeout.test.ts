import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { verifyDescopeToken } from './descope.js';

const projectId = 'Ptest000000000000000000000000';
const opaqueJwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZCJ9.e30.c2ln';
const required: Record<string, string> = {
  CIO_SITE_ID: 'test',
  CIO_TRACK_KEY: 'test',
  CIO_APP_API_BEARER: 'test',
  PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
  N8N_WEBHOOK_SECRET: 'c'.repeat(32),
};
const originalEnv = new Map<string, string | undefined>();
before(() => {
  for (const [key, value] of Object.entries(required)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  originalEnv.set('DESCOPE_PROJECT_ID', process.env.DESCOPE_PROJECT_ID);
  process.env.DESCOPE_PROJECT_ID = projectId;
  originalEnv.set('POSTHOG_GATEWAYOPS_KEY', process.env.POSTHOG_GATEWAYOPS_KEY);
  process.env.POSTHOG_GATEWAYOPS_KEY = 'synthetic-test-key';
});
after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function withShortTimeout(run: (signal: AbortSignal, timeoutMs: () => number) => Promise<void>) {
  const originalTimeout = AbortSignal.timeout;
  const controller = new AbortController();
  let timeout = 0;
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (ms: number) => {
      timeout = ms;
      setTimeout(() => controller.abort(new DOMException('synthetic timeout', 'TimeoutError')), 10);
      return controller.signal;
    },
  });
  try {
    await run(controller.signal, () => timeout);
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
  }
}

test('Descope JWKS request and response-body stalls are aborted at the bounded deadline', async () => {
  const originalFetch = globalThis.fetch;
  const telemetry: Array<Record<string, unknown>> = [];
  try {
    await withShortTimeout(async (signal, timeoutMs) => {
      let requestCancelled = false;
      globalThis.fetch = async (input, init) => {
        if (!String(input).includes('api.descope.com')) {
          telemetry.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return { ok: true, status: 200 } as Response;
        }
        assert.equal(init?.signal, signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            requestCancelled = true;
            reject(signal.reason);
          }, { once: true });
        });
      };
      const started = Date.now();
      assert.equal(await verifyDescopeToken(opaqueJwt), null, 'a stalled request fails closed');
      assert.equal(timeoutMs(), 5_000);
      assert.equal(requestCancelled, true);
      assert.ok(Date.now() - started < 500);
      await new Promise((resolve) => setImmediate(resolve));
      const event = telemetry.find((item) => item.event === 'gw_descope_auth');
      assert.ok(event);
      assert.equal((event.properties as Record<string, unknown>).outcome, 'jwks_unavailable');
      assert.equal(JSON.stringify(event).includes('synthetic timeout'), false, 'provider error details do not enter telemetry');
    });

    await withShortTimeout(async (signal, timeoutMs) => {
      let bodyCancelled = false;
      globalThis.fetch = async (input, init) => {
        if (!String(input).includes('api.descope.com')) {
          telemetry.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return { ok: true, status: 200 } as Response;
        }
        assert.equal(init?.signal, signal);
        return {
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              bodyCancelled = true;
              reject(signal.reason);
            }, { once: true });
          }),
        } as Response;
      };
      const started = Date.now();
      assert.equal(await verifyDescopeToken(opaqueJwt), null, 'a stalled response body fails closed');
      assert.equal(timeoutMs(), 5_000);
      assert.equal(bodyCancelled, true);
      assert.ok(Date.now() - started < 500);
      await new Promise((resolve) => setImmediate(resolve));
      const event = telemetry.find((item) => item.event === 'gw_descope_auth');
      assert.ok(event);
      assert.equal((event.properties as Record<string, unknown>).outcome, 'jwks_unavailable');
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Descope auth preserves static-token, JWKS cache, key rotation, and bad-signature behavior', async () => {
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
    assert.equal(jwksCalls, 0, 'static/non-JWT credentials do not fetch JWKS');
    const firstToken = signedToken('first-kid', first.privateKey);
    assert.equal((await verifyDescopeToken(firstToken))?.lane, 'clo');
    assert.equal(jwksCalls, 1);
    assert.equal((await verifyDescopeToken(firstToken))?.lane, 'clo');
    assert.equal(jwksCalls, 1, 'a warm JWKS cache is reused');

    jwks = [...jwks, { ...(rotated.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'rotated-kid', kty: 'RSA' }];
    assert.equal((await verifyDescopeToken(signedToken('rotated-kid', rotated.privateKey)))?.lane, 'clo');
    assert.equal(jwksCalls, 2, 'a missing key triggers refresh for rotation');
    assert.equal(await verifyDescopeToken(signedToken('rotated-kid', first.privateKey)), null, 'a bad signature fails closed');
    assert.equal(jwksCalls, 2, 'bad signatures are rejected against the cached key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
