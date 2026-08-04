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
  // Round 8 (2026-08-04, Copilot review PR #192): the fallback's queryType:'simple' keyword search
  // treats path characters like +, -, *, and quotes as query operators, not literal text, so it can
  // silently MISS a real exact-path document -- a false negative the client-side equality check
  // cannot rescue (it only narrows candidates the search already returned). The fallback can
  // therefore never claim confirmed-clean, even when it paginated through every result Azure's text
  // analyzer chose to return -- truncated must always be true here, unlike the primary $filter path.
  assert.equal(result.truncated, true, 'the keyword fallback can never prove completeness, so it must always report truncated');
  assert.match(result.reason ?? '', /cannot prove completeness/);
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

test('deindexChunkedPathWithAuth: paginates a document with MORE than one page of chunks (400) and deletes every one, backed by a STATEFUL fake index (2026-08-04, Copilot review PR #192 round 3)', async () => {
  // Backed by a mutable store that actually removes documents on delete and actually shrinks what
  // search returns -- this is what exposed the real bug in the ORIGINAL (buggy) implementation:
  // that version deleted each page as it was found, so by the time it queried `skip:200` the store
  // had already shrunk to 200 remaining docs, `skip:200` returned empty, and pagination stopped
  // reporting `exhausted:true` with 200 real matches still un-deleted. The fix (findAllChunkIds
  // paginates to completion BEFORE any delete happens) means every search call in this test sees
  // the FULL, unshrunk set, and this stateful stub is what proves that -- a stub that just serves a
  // fixed page 2 response regardless of prior deletes (the original round-2 test) cannot catch this
  // class of bug, which is exactly what Copilot's review flagged.
  const TOTAL = 400;
  const store = new Map<string, { chunk_id: string; path: string }>();
  for (let i = 0; i < TOTAL; i++) store.set(`c${i}`, { chunk_id: `c${i}`, path: 'big/doc.pdf' });
  const searchCalls: number[] = [];
  let deleteBatches = 0;

  const result = await withStubbedFetch(
    fullChainStub(
      (_u, init) => {
        const body = JSON.parse(String(init?.body)) as { skip: number; top: number };
        searchCalls.push(body.skip);
        const live = [...store.values()]; // reflects any deletes that have ALREADY happened
        const page = live.slice(body.skip, body.skip + body.top);
        return new Response(JSON.stringify({ value: page }), { status: 200 });
      },
      (_u, init) => {
        deleteBatches++;
        const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
        const results = body.value.map((v) => {
          const existed = store.delete(v.chunk_id);
          return { key: v.chunk_id, status: existed, statusCode: existed ? 200 : 404 };
        });
        return new Response(JSON.stringify({ value: results }), { status: 200 });
      },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'big/doc.pdf'),
  );

  assert.equal(result.deleted, TOTAL, `every one of the ${TOTAL} chunks must be confirmed deleted, not just the first page`);
  assert.equal(result.truncated, false);
  assert.equal(store.size, 0, 'the fake index must end up genuinely empty for this path');
  // 400 docs at 200/page -> pages at skip=0,200,400(empty, confirms exhaustion) = 3 search calls;
  // 400 confirmed deletes at 200/batch = 2 delete batches.
  assert.deepEqual(searchCalls, [0, 200, 400]);
  assert.equal(deleteBatches, 2);
});

test('deindexChunkedPathWithAuth: an UNORDERED result set (no $orderby -- Azure does not guarantee stable pagination) that returns a short page while real matches remain elsewhere is reported truncated:true, NOT falsely exhausted (2026-08-04, Copilot review PR #192 round 4)', async () => {
  // Simulates the exact failure Copilot flagged: 203 real matches exist. Page 0 (skip=0) returns a
  // full page of 200. Page 1 (skip=200), due to unstable ordering (or a concurrent write from the
  // independent pull-indexer), returns only 2 items -- and neither is one of the 3 chunks
  // (c200/c201/c202) that were never actually returned by ANY page. Under the OLD raw.length<PAGE_SIZE
  // heuristic, that short page 1 would have set exhausted:true, silently leaving c200-c202 stale
  // forever. With `count:true` wired through and `@odata.count` reported honestly by this stub,
  // the deduped-seen count (200) never reaches the server's own total (203), so pagination must
  // keep going -- and once it exhausts the page backstop without ever finding the missing 3, the
  // result must be truncated:true, not a false exhausted:true.
  const TOTAL = 203;
  let searchCalls = 0;
  const result = await withStubbedFetch(
    fullChainStub(
      (_u, init) => {
        searchCalls++;
        const body = JSON.parse(String(init?.body)) as { skip: number };
        if (body.skip === 0) {
          return new Response(
            JSON.stringify({
              '@odata.count': TOTAL,
              value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `c${i}`, path: 'reordered/doc.pdf' })),
            }),
            { status: 200 },
          );
        }
        if (body.skip === 200) {
          // A short page (2 items) that does NOT contain the missing c200/c201/c202 -- simulates
          // reordering returning already-seen items instead of the genuinely unvisited ones.
          return new Response(
            JSON.stringify({ '@odata.count': TOTAL, value: [{ chunk_id: 'c5', path: 'reordered/doc.pdf' }, { chunk_id: 'c10', path: 'reordered/doc.pdf' }] }),
            { status: 200 },
          );
        }
        // Every later offset keeps returning nothing new -- an exhausted/uncooperative reordering,
        // forcing the loop to genuinely hit the page backstop rather than ever converging.
        return new Response(JSON.stringify({ '@odata.count': TOTAL, value: [] }), { status: 200 });
      },
      okDelete(),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'reordered/doc.pdf'),
  );
  assert.ok(searchCalls > 2, 'must keep paging past the short page 1 instead of stopping there (proves the count check, not raw.length, controls exhaustion)');
  assert.equal(result.truncated, true, 'must NOT falsely report exhausted -- 3 real matches (c200-c202) were never found by any page');
  assert.equal(result.deleted, 200, 'the 200 chunks that WERE found (deduped: c5/c10 seen twice) must still be confirmedly deleted, even though the batch overall is truncated');
});

test('deindexChunkedPathWithAuth: an unordered result set that DOES eventually surface every chunk (just not in a naive page-size order) is correctly reported exhausted:true once the authoritative count is satisfied', async () => {
  const TOTAL = 205;
  const result = await withStubbedFetch(
    fullChainStub(
      (_u, init) => {
        const body = JSON.parse(String(init?.body)) as { skip: number };
        if (body.skip === 0) {
          return new Response(
            JSON.stringify({ '@odata.count': TOTAL, value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `c${i}`, path: 'x.pdf' })) }),
            { status: 200 },
          );
        }
        if (body.skip === 200) {
          // Heavily overlaps page 0 (reordering) but DOES include 3 genuinely new ids.
          return new Response(
            JSON.stringify({
              '@odata.count': TOTAL,
              value: [
                ...Array.from({ length: 197 }, (_, i) => ({ chunk_id: `c${i + 3}`, path: 'x.pdf' })), // c3..c199, all dupes
                { chunk_id: 'c200', path: 'x.pdf' }, { chunk_id: 'c201', path: 'x.pdf' }, { chunk_id: 'c202', path: 'x.pdf' },
              ],
            }),
            { status: 200 },
          );
        }
        if (body.skip === 400) {
          // The last 2 genuinely missing ids finally surface here.
          return new Response(
            JSON.stringify({ '@odata.count': TOTAL, value: [{ chunk_id: 'c203', path: 'x.pdf' }, { chunk_id: 'c204', path: 'x.pdf' }] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected skip ${body.skip}`);
      },
      okDelete(),
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'x.pdf'),
  );
  assert.equal(result.deleted, TOTAL, 'every distinct chunk across the overlapping/reordered pages must be found and confirmed deleted');
  assert.equal(result.truncated, false, 'once the deduped count reaches the server-reported total, this is a genuine, honest exhaustion');
});

test('deindexChunkedPathWithAuth: a GROWING @odata.count mid-pagination (the concurrent indexer inserts a new chunk between pages) is tracked, not frozen at page 0 (2026-08-04, Copilot review PR #192 round 8)', async () => {
  // 400 real chunks exist at page 0. Between page 0 and page 1, the independent pull-indexer inserts
  // a brand new chunk (cNEW) -- Azure's own count now reports 401. Due to the same unordered-result
  // instability the round-4 tests already cover, one of the ORIGINAL 400 chunks (c399) gets shifted
  // behind page 1's offset and is not returned until page 2, while cNEW happens to surface early.
  // Old code froze `expectedRawCount` at page 0's count (400): by the end of page 1, seenRaw would
  // already total exactly 400 distinct ids (c0-c199 + c200-c398 + cNEW), satisfying that STALE target
  // and reporting a false exhausted:true -- while c399, a real pre-existing chunk, was never found or
  // deleted. The fix tracks the MAXIMUM count observed across all pages (401, from page 1), so
  // pagination correctly continues to page 2 and finds c399 too.
  const TOTAL_AFTER_INSERT = 401;
  let searchCalls = 0;
  let deleteBody: { value: Array<{ chunk_id: string }> } | undefined;
  const seenDeleteIds = new Set<string>();
  const result = await withStubbedFetch(
    fullChainStub(
      (_u, init) => {
        searchCalls++;
        const body = JSON.parse(String(init?.body)) as { skip: number };
        if (body.skip === 0) {
          // Page 0: the original 400-count snapshot, 200 items (c0..c199).
          return new Response(
            JSON.stringify({
              '@odata.count': 400,
              value: Array.from({ length: 200 }, (_, i) => ({ chunk_id: `c${i}`, path: 'growing/doc.pdf' })),
            }),
            { status: 200 },
          );
        }
        if (body.skip === 200) {
          // Page 1: the indexer's insert is now visible -- count GREW to 401. Returns c200..c398
          // (199 of the original chunks) plus the brand new cNEW -- but NOT c399, which reordering
          // has shifted behind this offset.
          return new Response(
            JSON.stringify({
              '@odata.count': TOTAL_AFTER_INSERT,
              value: [
                ...Array.from({ length: 199 }, (_, i) => ({ chunk_id: `c${i + 200}`, path: 'growing/doc.pdf' })),
                { chunk_id: 'cNEW', path: 'growing/doc.pdf' },
              ],
            }),
            { status: 200 },
          );
        }
        if (body.skip === 400) {
          // Page 2: only reachable if the loop correctly kept going past page 1's stale-looking
          // seenRaw==400 milestone -- this is where the genuinely missing c399 finally surfaces.
          return new Response(
            JSON.stringify({ '@odata.count': TOTAL_AFTER_INSERT, value: [{ chunk_id: 'c399', path: 'growing/doc.pdf' }] }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected skip ${body.skip}`);
      },
      (_u, init) => {
        deleteBody = JSON.parse(String(init?.body));
        for (const v of deleteBody!.value) seenDeleteIds.add(v.chunk_id);
        return okDelete()(_u, init);
      },
    ),
    () => deindexChunkedPathWithAuth(DIRECT_AUTH, 'legal-personal', 'growing/doc.pdf'),
  );
  assert.equal(searchCalls, 3, 'must page all the way to skip=400 to find c399 -- the old frozen-count code would have wrongly stopped after page 1 (2 calls)');
  assert.equal(result.deleted, TOTAL_AFTER_INSERT, 'all 401 chunks -- including the one shifted behind the offset by the concurrent insert -- must be confirmed deleted');
  assert.equal(result.truncated, false, 'once the deduped count reaches the GROWN (not stale) authoritative total, this is a genuine, honest exhaustion');
  assert.ok(seenDeleteIds.has('c399'), 'c399 -- the chunk a frozen count would have silently left stale -- must actually have been deleted');
});

test('deindexChunkedPathWithAuth: a document exceeding the 10,000-chunk backstop is reported truncated:true, not silently short (2026-08-04 round-2 fix)', async () => {
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
  assert.match(result.reason ?? '', /1\/2 chunk delete\(s\) not confirmed/);
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

test('deindexChunkedPath (one-shot): prepareDeindexAuth\'s own short internal deadline bounds a hung identity mint (fires well before the outer 10s deadline)', async () => {
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
  // prepareDeindexAuth's own default deadline (DEINDEX_AUTH_DEADLINE_MS, 3s) is shorter than the
  // one-shot wrapper's outer deadline (10s) and resolves the hang first -- proves auth resolution
  // cannot itself dominate the one-shot budget, distinct from the outer-deadline test below.
  assert.ok(elapsedMs < 8_000, `a hung identity mint must be caught by prepareDeindexAuth's own ~3s deadline, well before the outer 10s one; took ${elapsedMs}ms`);
  assert.equal(result.attempted, false);
  assert.equal(result.deleted, 0);
  assert.equal(result.truncated, true);
  assert.match(result.reason ?? '', /deadline/);
});

test('deindexChunkedPath (one-shot): a search call that hangs past prepareDeindexAuth\'s own return is bounded to ~10s, not left hanging indefinitely (2026-08-04, Copilot review PR #192 round 5)', async () => {
  // identity + admin-key resolve fast (via fullChainStub's default handling); the search lookup
  // itself then hangs forever, simulating a stuck call that somehow evades fetchWithBudget's own
  // AbortSignal-based timeout (e.g. a proxy that swallows aborts). TWO independent mechanisms now
  // bound this, both targeting the SAME deadlineAtMs inherited from the one-shot wrapper: the
  // OUTER Promise.race in deindexChunkedPath (present since round 2), and the IN-FLIGHT race
  // findAllChunkIds now wraps its own search call in (added round 5, matching Copilot's ask to
  // race each lookup, not just gate entry into it). Because both timers target the same absolute
  // wall-clock instant, WHICH ONE actually wins is a genuine Node timer-ordering race, not a
  // deterministic outcome -- so this test deliberately does NOT pin `attempted` to a specific
  // value (true via the inner race resolving findAllChunkIds normally, or false via the outer
  // wrapper's own timeout value, are BOTH correct depending on microsecond scheduling). What must
  // always hold regardless of which fires first: bounded elapsed time, an honest truncated:true,
  // zero confirmed deletes, and a reason that says why.
  const started = Date.now();
  const result = await withStubbedFetch(
    fullChainStub(
      () => new Promise<Response>(() => {}),
      () => { throw new Error('must never reach the delete call in this test'); },
    ),
    () => deindexChunkedPath('legal-personal', 'filings/x.pdf'),
  );
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs >= 9_000 && elapsedMs < 15_000, `must be bounded to ~10s by one of the two deadline mechanisms, not hang indefinitely; took ${elapsedMs}ms`);
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
