// deindexChunkedPath (2026-08-04, CLO field report Finding 3) integration behavior. Lives in its
// OWN test file (its own `node --test` child process), same reason as cosmos-aad.test.ts: this
// file's whole env snapshot (a real-looking AZURE_SEARCH_ENDPOINT + fake IDENTITY_ENDPOINT/
// IDENTITY_HEADER so the managed-identity chain actually runs instead of short-circuiting) must be
// set BEFORE the first call into search-write.js, and config/env.ts's loadEnv() memoizes for the
// process lifetime, so a DIFFERENT env snapshot (search-write.test.ts's pure-function tests, which
// carry no env at all) cannot coexist with this one.
//
// The managed-identity TOKEN-FETCH-FAILURE case is deliberately NOT tested in this file (Copilot
// review, PR #192): arm-client.ts's `miToken` caches the ARM token in a module-level Map for the
// process lifetime, so once any test in THIS file successfully mints a token, every later test
// silently reuses the cache and never re-hits the identity endpoint at all -- a failure-path test
// placed after a success-path test would "pass" by accident, via its stub's generic catch-all
// throw, not because the intended branch actually ran. See search-write-deindex-identity-failure.test.ts,
// which is isolated in its own process specifically so nothing can prime that cache first.
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

const { deindexChunkedPath, deindexChunkedPathWithAuth, prepareDeindexAuth, findChunkIdsByPath } = await import('./search-write.js');

// Same pattern as cosmos-aad.test.ts / foundry.test.ts: stub the genuine globalThis.fetch (node:test's
// mock.method() limitation on this repo's ESM build does not apply to a real global).
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const isIdentityCall = (url: string | URL) => String(url).includes('fake-identity.example.invalid');
const isAdminKeyCall = (url: string | URL) => String(url).includes('listAdminKeys');
const isSearchDocsCall = (url: string | URL) => String(url).includes('/docs/search');
const isIndexDocsCall = (url: string | URL) => String(url).includes('/docs/index');

const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
const FAKE_ADMIN_KEY = 'fake-admin-key-0123456789';

/** A stub that serves the identity + ARM admin-key hops identically across every test in this file,
 *  and delegates the actual search-service calls (docs/search, docs/index) to `onSearchCall`. */
function fullChainStub(onSearchCall: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isIdentityCall(u)) {
      return new Response(
        JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
        { status: 200 },
      );
    }
    if (isAdminKeyCall(u)) {
      return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 });
    }
    return onSearchCall(u, init);
  }) as typeof fetch;
}

test('findChunkIdsByPath: primary $filter path returns chunk_ids on a 200', async () => {
  let searchCalls = 0;
  const ids = await withStubbedFetch(
    fullChainStub((u) => {
      searchCalls++;
      assert.ok(isSearchDocsCall(u));
      return new Response(
        JSON.stringify({ value: [{ chunk_id: 'c1', path: 'foo/bar.pdf' }, { chunk_id: 'c2', path: 'foo/bar.pdf' }] }),
        { status: 200 },
      );
    }),
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'foo/bar.pdf'),
  );
  assert.deepEqual(ids, ['c1', 'c2']);
  assert.equal(searchCalls, 1, 'the $filter path succeeding must not trigger the fallback search');
});

test('findChunkIdsByPath: a non-ok $filter (schema does not allow filtering on path) falls back to a keyword search with client-side exact match', async () => {
  let calls = 0;
  const ids = await withStubbedFetch(
    fullChainStub((u, init) => {
      calls++;
      if (calls === 1) return new Response('{"error":"path is not filterable"}', { status: 400 });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.searchFields, 'path');
      assert.equal(body.search, 'foo/bar.pdf');
      // one exact match plus one near-miss that must be dropped by the client-side check
      return new Response(
        JSON.stringify({
          value: [
            { chunk_id: 'c1', path: 'foo/bar.pdf' },
            { chunk_id: 'c9', path: 'foo/bar.pdf.bak' },
          ],
        }),
        { status: 200 },
      );
    }),
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'foo/bar.pdf'),
  );
  assert.equal(calls, 2, 'must try $filter first, then fall back exactly once');
  assert.deepEqual(ids, ['c1'], 'the near-miss path must be excluded by the client-side exact-match check');
});

test('findChunkIdsByPath: both the primary and fallback failing returns [] (never throws)', async () => {
  const ids = await withStubbedFetch(
    fullChainStub(() => new Response('boom', { status: 500 })),
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'foo/bar.pdf'),
  );
  assert.deepEqual(ids, []);
});

test('findChunkIdsByPath: a network throw returns [] (never throws)', async () => {
  const ids = await withStubbedFetch(
    (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch,
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'foo/bar.pdf'),
  );
  assert.deepEqual(ids, []);
});

test('deindexChunkedPath: full success path deletes every chunk found at the path (real 4-hop chain: identity -> admin key -> search -> delete)', async () => {
  let deleteBody: { value?: Array<Record<string, unknown>> } | undefined;
  await withStubbedFetch(
    fullChainStub((u, init) => {
      if (isSearchDocsCall(u)) {
        return new Response(
          JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/moved.pdf' }, { chunk_id: 'c2', path: 'filings/moved.pdf' }] }),
          { status: 200 },
        );
      }
      if (isIndexDocsCall(u)) {
        deleteBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ value: [{ status: true }, { status: true }] }), { status: 200 });
      }
      throw new Error(`unexpected search-service call: ${u}`);
    }),
    async () => {
      const result = await deindexChunkedPath('legal-personal', 'filings/moved.pdf');
      assert.deepEqual(result, { attempted: true, deleted: 2 });
    },
  );
  assert.ok(deleteBody, 'the delete batch must actually have been sent');
  assert.deepEqual(
    deleteBody!.value,
    [
      { '@search.action': 'delete', chunk_id: 'c1' },
      { '@search.action': 'delete', chunk_id: 'c2' },
    ],
  );
});

test('deindexChunkedPath: zero chunks found at the path is a normal no-op, not a failure', async () => {
  const result = await withStubbedFetch(
    fullChainStub((u) => {
      assert.ok(isSearchDocsCall(u), 'must never reach the delete call when nothing was found');
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    }),
    () => deindexChunkedPath('legal-personal', 'filings/never-indexed.pdf'),
  );
  assert.deepEqual(result, { attempted: true, deleted: 0 });
});

test('deindexChunkedPath: the delete POST itself failing is reported, not thrown', async () => {
  const result = await withStubbedFetch(
    fullChainStub((u) => {
      if (isSearchDocsCall(u)) {
        return new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/moved.pdf' }] }), { status: 200 });
      }
      return new Response('index locked', { status: 503 });
    }),
    () => deindexChunkedPath('legal-personal', 'filings/moved.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.match(result.reason ?? '', /delete 503/);
});

test('findChunkIdsByPath: paginates the $filter path across multiple pages until exhausted', async () => {
  const seenSkips: number[] = [];
  const ids = await withStubbedFetch(
    fullChainStub((u, init) => {
      const body = JSON.parse(String(init?.body));
      seenSkips.push(body.skip);
      // page 0: exactly a full page (200) so pagination must continue; page 1: a partial page (2),
      // which must stop pagination.
      if (body.skip === 0) {
        return new Response(
          JSON.stringify({ value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `p0-${i}`, path: 'big/doc.pdf' })) }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ value: [{ chunk_id: 'p1-0', path: 'big/doc.pdf' }, { chunk_id: 'p1-1', path: 'big/doc.pdf' }] }),
        { status: 200 },
      );
    }),
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'big/doc.pdf'),
  );
  assert.deepEqual(seenSkips, [0, 200], 'must request exactly two pages (skip=0 then skip=200), then stop on the short page');
  assert.equal(ids.length, 202);
  assert.equal(ids[0], 'p0-0');
  assert.equal(ids[201], 'p1-1');
});

test('findChunkIdsByPath: a full-size page every time stops at DEINDEX_MAX_PAGES (safety backstop, not an expected ceiling)', async () => {
  let calls = 0;
  const ids = await withStubbedFetch(
    fullChainStub(() => {
      calls++;
      return new Response(
        JSON.stringify({ value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `c${calls}-${i}`, path: 'huge/doc.pdf' })) }),
        { status: 200 },
      );
    }),
    () => findChunkIdsByPath('https://fake.search.windows.net', 'k', 'legal-personal', 'huge/doc.pdf'),
  );
  assert.equal(calls, 5, 'must stop at the DEINDEX_MAX_PAGES backstop rather than paginating forever');
  assert.equal(ids.length, 1000);
});

test('deindexChunkedPathWithAuth: a 207 Multi-Status (some chunk deletes failed) counts only confirmed successes, and reports the failure', async () => {
  const auth = { endpoint: 'https://fake.search.windows.net', key: 'k' };
  const result = await withStubbedFetch(
    ((url: string | URL) => {
      const u = String(url);
      if (isSearchDocsCall(u)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/x.pdf' }, { chunk_id: 'c2', path: 'filings/x.pdf' }] }),
            { status: 200 },
          ),
        );
      }
      if (isIndexDocsCall(u)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              value: [
                { key: 'c1', status: true, statusCode: 200 },
                { key: 'c2', status: false, statusCode: 409, errorMessage: 'a concurrent edit' },
              ],
            }),
            { status: 207 },
          ),
        );
      }
      throw new Error(`unexpected call: ${u}`);
    }) as typeof fetch,
    () => deindexChunkedPathWithAuth(auth, 'legal-personal', 'filings/x.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 1, 'only the confirmed-true chunk counts as deleted, not chunkIds.length');
  assert.match(result.reason ?? '', /1\/2 chunk delete\(s\) failed/);
});

test('prepareDeindexAuth + deindexChunkedPathWithAuth: auth resolved ONCE serves multiple deindex calls (no repeat admin-key fetch)', async () => {
  let adminKeyCalls = 0;
  let identityCalls = 0;
  const { auth } = await withStubbedFetch(
    fullChainStub(() => new Response(JSON.stringify({ value: [] }), { status: 200 })),
    () => prepareDeindexAuth(),
  );
  assert.ok(auth, 'prepareDeindexAuth must resolve real auth given a working identity+ARM chain');

  await withStubbedFetch(
    ((url: string | URL) => {
      const u = String(url);
      if (isIdentityCall(u)) { identityCalls++; throw new Error('identity must not be called again -- auth was already resolved'); }
      if (isAdminKeyCall(u)) { adminKeyCalls++; throw new Error('admin key must not be re-fetched -- auth was already resolved'); }
      return Promise.resolve(new Response(JSON.stringify({ value: [] }), { status: 200 }));
    }) as typeof fetch,
    async () => {
      const r1 = await deindexChunkedPathWithAuth(auth!, 'legal-personal', 'a.pdf');
      const r2 = await deindexChunkedPathWithAuth(auth!, 'legal-personal', 'b.pdf');
      assert.deepEqual(r1, { attempted: true, deleted: 0 });
      assert.deepEqual(r2, { attempted: true, deleted: 0 });
    },
  );
  assert.equal(identityCalls, 0);
  assert.equal(adminKeyCalls, 0);
});
