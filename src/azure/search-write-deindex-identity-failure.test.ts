// deindexChunkedPath: managed-identity token-fetch failure path, ISOLATED in its own file/process
// (2026-08-04, Copilot review PR #192). arm-client.ts's `miToken` caches the minted ARM token in a
// module-level Map for the LIFETIME OF THE PROCESS. search-write-deindex.test.ts's success-path
// tests mint and cache a real token; if this failure-path test ran in that same process (even in
// its own `test()` block), miToken would silently return the cached token instead of calling the
// identity endpoint at all, and the assertions below would "pass" via the stub's generic
// catch-all throw somewhere downstream -- not because the identity-mint failure was ever actually
// exercised. Isolating this in its OWN file guarantees a fresh process with an empty token cache,
// and the identityCalls counter below proves the intended branch genuinely ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-s1.search.windows.net';
process.env.IDENTITY_ENDPOINT ||= 'http://fake-identity.example.invalid/msi/token';
process.env.IDENTITY_HEADER ||= 'fake-identity-header-secret';

const { deindexChunkedPath } = await import('./search-write.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// Parse + compare the hostname rather than a bare substring search (CodeQL
// js/incomplete-url-substring-sanitization; see the identical fix + rationale in
// blob-deindex-configured.test.ts, 2026-08-04).
const isIdentityCall = (url: string | URL) => {
  try { return new URL(url).hostname === 'fake-identity.example.invalid'; } catch { return false; }
};

test('deindexChunkedPath: a managed-identity token-fetch failure fails open ({attempted:false}), never throws, and never reaches ARM or the search service', async () => {
  let identityCalls = 0;
  const result = await withStubbedFetch(
    (async (url: string | URL) => {
      if (isIdentityCall(url)) {
        identityCalls++;
        return new Response('{"error":"identity_unavailable"}', { status: 403 });
      }
      throw new Error('must never reach ARM or the search service when the identity mint failed');
    }) as typeof fetch,
    () => deindexChunkedPath('legal-personal', 'filings/moved.pdf'),
  );
  assert.equal(identityCalls, 1, 'the identity endpoint must have actually been hit exactly once -- proves this is a genuine cache-miss run, not a stale-cache pass');
  assert.equal(result.attempted, false);
  assert.equal(result.deleted, 0);
  assert.ok(result.reason);
});
