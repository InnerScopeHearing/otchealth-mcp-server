// deindexChunkedPath (2026-08-04, CLO field report Finding 3) integration behavior. Lives in its
// OWN test file (its own `node --test` child process), same reason as cosmos-aad.test.ts: this
// file's whole env snapshot (a real-looking AZURE_SEARCH_ENDPOINT + fake IDENTITY_ENDPOINT/
// IDENTITY_HEADER so the managed-identity chain actually runs instead of short-circuiting) must be
// set BEFORE the first call into search-write.js, and config/env.ts's loadEnv() memoizes for the
// process lifetime, so a DIFFERENT env snapshot (search-write.test.ts's pure-function tests, which
// carry no env at all) cannot coexist with this one.
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

const { deindexChunkedPath, findChunkIdsByPath } = await import('./search-write.js');

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

test('deindexChunkedPath: a managed-identity token-fetch failure fails open ({attempted:false}), never throws', async () => {
  const result = await withStubbedFetch(
    (async (url: string | URL) => {
      if (isIdentityCall(url)) return new Response('{"error":"identity_unavailable"}', { status: 403 });
      throw new Error('must never reach ARM or the search service when the identity mint failed');
    }) as typeof fetch,
    () => deindexChunkedPath('legal-personal', 'filings/moved.pdf'),
  );
  assert.equal(result.attempted, false);
  assert.equal(result.deleted, 0);
  assert.ok(result.reason);
});
