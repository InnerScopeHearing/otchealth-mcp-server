// COSMOS_AUTH_MODE=aad integration behavior: token-fetch failure, success header shape, and
// in-memory caching. Lives in its OWN test file (its own `node --test` child process) because
// src/config/env.ts's loadEnv() memoizes the parsed env for the lifetime of the process -- once
// any code calls it, later process.env mutations are invisible to it. This file's whole env
// snapshot (COSMOS_AUTH_MODE=aad, no COSMOS_KEY, fake IDENTITY_ENDPOINT/IDENTITY_HEADER) is set
// BEFORE the first call into cosmos.js, mirroring src/azure/foundry.test.ts's pattern. The
// default/key-mode regression pin lives separately in cosmos-keymode.test.ts for the same reason
// (a DIFFERENT env snapshot cannot coexist with this one in a single process).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

process.env.COSMOS_ENDPOINT ||= 'https://fake-cosmos.example.invalid';
process.env.COSMOS_AUTH_MODE ||= 'aad';
delete process.env.COSMOS_KEY; // aad mode must work with NO master key present at all
process.env.IDENTITY_ENDPOINT ||= 'http://fake-identity.example.invalid/msi/token';
process.env.IDENTITY_HEADER ||= 'fake-identity-header-secret';

const { isConfigured, readDoc, aadAuthToken } = await import('./cosmos.js');

// Pure, no real network: every case stubs globalThis.fetch directly (same pattern as
// src/util/fetch-budget.test.ts / src/azure/foundry.test.ts -- a genuine global, not another
// module's live named export, so node:test's mock.method() limitation on this repo's ESM build
// does not apply here).
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const isIdentityCall = (url: string | URL): boolean => String(url).includes('fake-identity.example.invalid');

test('isConfigured(): true in aad mode with COSMOS_ENDPOINT set and COSMOS_KEY unset', () => {
  assert.equal(process.env.COSMOS_KEY, undefined, 'precondition: COSMOS_KEY must be genuinely unset for this test to mean anything');
  assert.equal(isConfigured(), true);
});

// MUST run before any test that lets a token mint succeed: miToken()'s in-memory cache (keyed by
// resource, arm-client.ts) lives for this whole process, and a resource string as specific as
// "https://cosmos.azure.com" is only ever touched by this file's tests -- so ordering within this
// file (not across files) is what keeps a later successful mint from masking this failure path.
test('aad mode: a managed-identity token-fetch failure throws a CLEAR error, never falls back to the master key', async () => {
  let identityCalls = 0;
  let cosmosCalls = 0;
  await withStubbedFetch(
    (async (url: string | URL) => {
      if (isIdentityCall(url)) {
        identityCalls++;
        return new Response('{"error":"identity_unavailable"}', { status: 403 });
      }
      cosmosCalls++;
      return new Response('{}', { status: 200 }); // should never be reached
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        () => readDoc('tasks', 'testpk', 'testid'),
        (err: Error) => {
          assert.match(err.message, /Cosmos AAD token fetch failed/);
          assert.match(err.message, /COSMOS_AUTH_MODE=aad/);
          assert.match(err.message, /does NOT/i, 'must say it does not silently fall back to the master key');
          return true;
        },
      );
    },
  );
  assert.equal(identityCalls, 1, 'a non-retryable 403 should mean exactly one identity-token attempt');
  assert.equal(cosmosCalls, 0, 'the Cosmos REST call must never happen when the token mint failed');
});

test('aad mode: success builds Authorization=type=aad&ver=1.0&sig=<token>, and caches the token (one mint serves two calls)', async () => {
  const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
  let identityCalls = 0;
  let cosmosCalls = 0;
  const capturedAuthHeaders: string[] = [];

  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      if (isIdentityCall(url)) {
        identityCalls++;
        return new Response(
          JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
          { status: 200 },
        );
      }
      cosmosCalls++;
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuthHeaders.push(headers?.['Authorization'] ?? headers?.['authorization'] ?? '');
      // Shape readDoc() expects: the raw document body (readDoc casts res.body directly).
      return new Response(JSON.stringify({ id: 'testid', hello: 'world' }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const first = await readDoc('tasks', 'testpk', 'testid');
      const second = await readDoc('tasks', 'testpk', 'testid');
      assert.equal(first?.doc.hello, 'world', 'the round trip must actually return the stubbed doc body');
      assert.equal(second?.doc.hello, 'world');
    },
  );

  assert.equal(cosmosCalls, 2, 'both readDoc() calls must reach the Cosmos endpoint');
  assert.equal(identityCalls, 1, 'the SECOND call must reuse the cached token -- exactly one identity-token mint for two Cosmos calls');

  const expected = aadAuthToken(FAKE_TOKEN);
  assert.equal(capturedAuthHeaders.length, 2);
  for (const h of capturedAuthHeaders) {
    assert.equal(h, expected, 'Authorization header must equal the url-encoded type=aad&ver=1.0&sig=<token>');
    assert.ok(h.startsWith('type%3Daad%26ver%3D1.0%26sig%3D'), 'must be aad-shaped');
    assert.ok(!h.startsWith('type%3Dmaster'), 'the HMAC/master-key path must never be invoked in aad mode');
    // FAKE_TOKEN contains only unreserved characters (letters/digits/dots), so encodeURIComponent
    // leaves it byte-for-byte -- this directly confirms sig carries the raw token, not an HMAC digest.
    assert.ok(h.includes(FAKE_TOKEN), 'sig must carry the raw token bytes verbatim, not an HMAC digest');
  }
});
