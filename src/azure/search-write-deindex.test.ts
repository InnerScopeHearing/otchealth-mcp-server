// deindexChunkedPath / deindexChunkedPathWithAuth (2026-08-04, CLO field report Finding 3, hardened
// against Copilot review PR #192 round 2: bounded timeouts, real pagination, 207 handling, and an
// overall deadline). Lives in its OWN test file (its own `node --test` child process), same reason
// as cosmos-aad.test.ts: this file's whole env snapshot (a real-looking AZURE_SEARCH_ENDPOINT +
// fake IDENTITY_ENDPOINT/IDENTITY_HEADER so the managed-identity chain actually runs instead of
// short-circuiting) must be set BEFORE the first call into search-write.js, and config/env.ts's
// loadEnv() memoizes for the process lifetime, so a DIFFERENT env snapshot (search-write.test.ts's
// pure-function tests, which carry no env at all) cannot coexist with this one.
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

const { deindexChunkedPath, deindexChunkedPathWithAuth, prepareDeindexAuth } = await import('./search-write.js');

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

// Parse + compare the hostname rather than a bare substring search (CodeQL
// js/incomplete-url-substring-sanitization -- a raw `.includes('fake-identity.example.invalid')`
// would also match an attacker-controlled host with that string embedded anywhere). These URLs
// are entirely internal (stub responses this same test constructs), but the fix is the same
// either way, and matches the fix applied to blob-deindex-configured.test.ts (2026-08-04).
const isIdentityCall = (url: string | URL) => {
  try { return new URL(url).hostname === 'fake-identity.example.invalid'; } catch { return false; }
};
const isAdminKeyCall = (url: string | URL) => String(url).includes('listAdminKeys'); // path/query token, not a hostname
const isSearchDocsCall = (url: string | URL) => String(url).includes('/docs/search'); // path token
const isIndexDocsCall = (url: string | URL) => String(url).includes('/docs/index'); // path token

const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
const FAKE_ADMIN_KEY = 'fake-admin-key-0123456789';
const DIRECT_AUTH = { endpoint: 'https://fake.search.windows.net', key: 'k' };

/** A stub that serves the identity + ARM admin-key hops identically across every test in this file,
 *  and delegates search (docs/search) and delete (docs/index) calls to separate handlers. */
function fullChainStub(
  onSearch: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  onDelete: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isIdentityCall(u)) {
      return new Response(
        JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
        { status: 200 },
      );
    }
    if (isAdminKeyCall(u)) return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 });
    if (isIndexDocsCall(u)) return onDelete(u, init);
    if (isSearchDocsCall(u)) return onSearch(u, init);
    throw new Error(`unexpected call: ${u}`);
  }) as typeof fetch;
}

/** A delete stub that reports every submitted chunk_id as a confirmed success. */
function okDelete(): (u: string, init: RequestInit | undefined) => Response {
  return (_u, init) => {
    const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
    return new Response(JSON.stringify({ value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) }), { status: 200 });
  };
}

test('deindexChunkedPathWithAuth: full success path finds and deletes every chunk on a single page (direct auth, no identity/ARM hops)', async () => {
  let searchCalls = 0;
  let deleteBody: { value?: Array<Record<string, unknown>> } | undefined;
  const result = await withStubbedFetch(
    fullChainStub(
      (u) => {
        searchCalls++;
        assert.ok(isSearchDocsCall(u));
        return new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/moved.pdf' }, { chunk_id: 'c2', path: 'filings/moved.pdf' }] }), { status: 200 });
      },
      (_u, init) => {
        deleteBody = JSON.parse(String(init?.body));
        return okDelete()(_u, init);
      },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'filings/moved.pdf'),
  );
  // Field-by-field, not assert.deepEqual against a literal without `reason` -- the real result
  // always carries an explicit `reason` key (possibly undefined), which deepEqual/deepStrictEqual
  // treats as distinct from a literal that omits the key entirely.
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 2);
  assert.equal(result.truncated, false);
  assert.equal(searchCalls, 1, 'a single, non-full page must not trigger a second page request');
  assert.deepEqual(deleteBody!.value, [
    { '@search.action': 'delete', chunk_id: 'c1' },
    { '@search.action': 'delete', chunk_id: 'c2' },
  ]);
});

test('deindexChunkedPathWithAuth: zero chunks found at the path is a normal no-op, not a failure, and never reaches the delete endpoint', async () => {
  const result = await withStubbedFetch(
    fullChainStub(
      (u) => { assert.ok(isSearchDocsCall(u)); return new Response(JSON.stringify({ value: [] }), { status: 200 }); },
      () => { throw new Error('must never reach the delete call when nothing was found'); },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'filings/never-indexed.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, false);
});

test('deindexChunkedPathWithAuth: a non-ok $filter (schema does not allow filtering on path) falls back to a keyword search with client-side exact match', async () => {
  let searchCalls = 0;
  const result = await withStubbedFetch(
    fullChainStub(
      (u, init) => {
        searchCalls++;
        if (searchCalls === 1) return new Response('{"error":"path is not filterable"}', { status: 400 });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.searchFields, 'path');
        assert.equal(body.search, 'foo/bar.pdf');
        // one exact match plus one near-miss that must be dropped by the client-side check
        return new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'foo/bar.pdf' }, { chunk_id: 'c9', path: 'foo/bar.pdf.bak' }] }), { status: 200 });
      },
      okDelete(),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'foo/bar.pdf'),
  );
  assert.equal(searchCalls, 2, 'must try $filter first, then fall back exactly once');
  assert.equal(result.deleted, 1, 'only the exact-match chunk must be deleted, not the near-miss');
});

test('deindexChunkedPathWithAuth: both the primary and fallback failing returns deleted:0, attempted:true, truncated:true (never throws)', async () => {
  const result = await withStubbedFetch(
    fullChainStub(
      () => new Response('boom', { status: 500 }),
      () => { throw new Error('must never reach delete when search itself failed'); },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'foo/bar.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
});

test('deindexChunkedPathWithAuth: a network throw on the search call returns gracefully (never throws)', async () => {
  const result = await withStubbedFetch(
    (async () => { throw new Error('ECONNRESET'); }) as typeof fetch,
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'foo/bar.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
});

test('deindexChunkedPathWithAuth: paginates the $filter path across multiple pages, deleting each page as it is found', async () => {
  const seenSkips: number[] = [];
  const deletedIds: string[] = [];
  const result = await withStubbedFetch(
    fullChainStub(
      (_u, init) => {
        const body = JSON.parse(String(init?.body));
        seenSkips.push(body.skip);
        // page 0: exactly a full page (200) so pagination must continue; page 1: a partial page (2), which must stop pagination.
        if (body.skip === 0) {
          return new Response(JSON.stringify({ value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `p0-${i}`, path: 'big/doc.pdf' })) }), { status: 200 });
        }
        return new Response(JSON.stringify({ value: [{ chunk_id: 'p1-0', path: 'big/doc.pdf' }, { chunk_id: 'p1-1', path: 'big/doc.pdf' }] }), { status: 200 });
      },
      (_u, init) => {
        const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
        deletedIds.push(...body.value.map((v) => v.chunk_id));
        return okDelete()(_u, init);
      },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'big/doc.pdf'),
  );
  assert.deepEqual(seenSkips, [0, 200], 'must request exactly two pages (skip=0 then skip=200), then stop on the short page');
  assert.equal(result.deleted, 202);
  assert.equal(result.truncated, false, 'a normally-exhausted pagination is NOT truncated');
  assert.equal(deletedIds.length, 202, 'each page must be deleted as it is found, not accumulated then deleted once');
  assert.ok(deletedIds.includes('p0-0') && deletedIds.includes('p1-1'));
});

test('deindexChunkedPathWithAuth: a document exceeding the 1000-chunk backstop is reported truncated:true, not silently short (2026-08-04 round-2 fix)', async () => {
  let calls = 0;
  const result = await withStubbedFetch(
    fullChainStub(
      () => {
        calls++;
        return new Response(JSON.stringify({ value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `c${calls}-${i}`, path: 'huge/doc.pdf' })) }), { status: 200 });
      },
      okDelete(),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'huge/doc.pdf'),
  );
  assert.equal(calls, 50, 'must stop at the DEINDEX_MAX_PAGES backstop rather than paginating forever');
  assert.equal(result.deleted, 10000);
  assert.equal(result.truncated, true, 'hitting the page backstop without confirming exhaustion must be reported, not hidden');
  assert.match(result.reason ?? '', /safety backstop/);
});

test('deindexChunkedPathWithAuth: a 207 Multi-Status (some chunk deletes failed) counts only confirmed successes, and reports the failure', async () => {
  const result = await withStubbedFetch(
    fullChainStub(
      () => new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/x.pdf' }, { chunk_id: 'c2', path: 'filings/x.pdf' }] }), { status: 200 }),
      () => new Response(
        JSON.stringify({ value: [{ key: 'c1', status: true, statusCode: 200 }, { key: 'c2', status: false, statusCode: 409, errorMessage: 'a concurrent edit' }] }),
        { status: 207 },
      ),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'filings/x.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 1, 'only the confirmed-true chunk counts as deleted, not chunkIds.length');
  assert.equal(result.truncated, true, 'a page-level delete failure means the page is not confirmed clean');
  assert.match(result.reason ?? '', /1\/2 chunk delete\(s\) failed/);
});

test('deindexChunkedPathWithAuth: the delete POST itself failing outright (non-2xx/207) is reported, not thrown', async () => {
  const result = await withStubbedFetch(
    fullChainStub(
      () => new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'filings/moved.pdf' }] }), { status: 200 }),
      () => new Response('index locked', { status: 503 }),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'filings/moved.pdf'),
  );
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? '', /delete 503/);
});

test('deindexChunkedPathWithAuth: a deadline that has already passed reports truncated:true fast, without any network call', async () => {
  let calls = 0;
  const result = await withStubbedFetch(
    (async () => { calls++; throw new Error('must not call fetch at all past the deadline'); }) as typeof fetch,
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'anything.pdf', Date.now() - 1),
  );
  assert.equal(calls, 0);
  assert.equal(result.attempted, true);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? '', /deadline exceeded/);
});

test('deindexChunkedPath (one-shot): overall deadline bounds the WHOLE chain (auth + find + delete) -- a hung identity mint still returns within the deadline', async () => {
  const started = Date.now();
  const result = await withStubbedFetch(
    (async (url: string | URL) => {
      if (isIdentityCall(url)) {
        // Simulate an identity mint that never resolves, WITHOUT a real timer -- a raw pending
        // Promise (no setTimeout/setInterval) registers no libuv handle, so it cannot itself keep
        // the test process alive past this test; only withDeadline's own short-lived timer does.
        return new Promise<Response>(() => {});
      }
      throw new Error('must not reach ARM or the search service in this test');
    }) as typeof fetch,
    () => deindexChunkedPath('legal-personal', 'filings/x.pdf'),
  );
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 15_000, `deindexChunkedPath must return well under its 10s deadline even when auth hangs; took ${elapsedMs}ms`);
  assert.equal(result.attempted, false);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? '', /deadline/);
});

test('prepareDeindexAuth + deindexChunkedPathWithAuth: auth resolved ONCE serves multiple deindex calls (no repeat admin-key fetch)', async () => {
  let adminKeyCalls = 0;
  let identityCalls = 0;
  const { auth } = await withStubbedFetch(
    fullChainStub(() => new Response(JSON.stringify({ value: [] }), { status: 200 }), okDelete()),
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
      for (const r of [r1, r2]) {
        assert.equal(r.attempted, true);
        assert.equal(r.deleted, 0);
        assert.equal(r.truncated, false);
      }
    },
  );
  assert.equal(identityCalls, 0);
  assert.equal(adminKeyCalls, 0);
});
