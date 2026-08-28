// "Configured" full-chain integration tests for legal_blob_move / legal_blob_delete's search
// de-indexing (2026-08-04, Copilot review PR #192 round 2): the existing blob-move.test.ts and
// blob-delete.test.ts deliberately carry NO AZURE_SEARCH_ENDPOINT/IDENTITY_ENDPOINT (mirroring
// "search unconfigured" in a dev environment), so their assertions only prove deindex fails open
// -- never that the real 4-hop chain (identity -> admin key -> search -> delete) fires with the
// correct index name, path, and ordering. This file sets the FULL env (blob store + search +
// managed identity) so the real chain runs, isolated in its own process for the same reason as
// cosmos-aad.test.ts / search-write-deindex.test.ts (config/env.ts's loadEnv() memoizes per
// process; this env snapshot must not leak into or be leaked into by a file with a different one).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin the pre-2026-08-28 backend defaults (env.ts's SEARCH_BACKEND/EMBEDDINGS_PROVIDER/
// LLM_PROVIDER/WEB_SEARCH_PROVIDER/BLOB_BACKEND/STATE_BACKEND now default to their AWS-native
// replacements) so this file keeps exercising exactly the Azure/Foundry/Cosmos code path it was
// written for -- those paths stay inert-but-present and still need this coverage.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-key-not-real').toString('base64');
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-s1.search.windows.net';
process.env.IDENTITY_ENDPOINT ||= 'http://fake-identity.example.invalid/msi/token';
process.env.IDENTITY_HEADER ||= 'fake-identity-header-secret';

const { handleLegalBlobMove } = await import('./blob-move.js');
const { handleLegalBlobDelete } = await import('./blob-delete.js');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

// A raw substring `.includes('.blob.core.windows.net')` would match an attacker-controlled host
// with that string embedded anywhere (e.g. "evil.example/.blob.core.windows.net.attacker.com"),
// which is exactly CodeQL's js/incomplete-url-substring-sanitization pattern -- flagged on this
// file (2026-08-04). These URLs are entirely internal (stub responses this same test constructs,
// never attacker input), but the fix is the same either way: parse the URL and check the hostname
// with a real boundary, not a bare substring search.
const BLOB_HOSTNAME = `${process.env.AZURE_LEGAL_STORAGE_ACCOUNT}.blob.core.windows.net`;
const isBlobCall = (u: string) => {
  try { return new URL(u).hostname === BLOB_HOSTNAME; } catch { return false; }
};
const isIdentityCall = (u: string) => {
  try { return new URL(u).hostname === 'fake-identity.example.invalid'; } catch { return false; }
};
const isAdminKeyCall = (u: string) => u.includes('listAdminKeys'); // a path/query token, not a hostname -- not the CodeQL pattern
const isSearchDocsCall = (u: string) => u.includes('/docs/search'); // path token
const isIndexDocsCall = (u: string) => u.includes('/docs/index'); // path token

const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
const FAKE_ADMIN_KEY = 'fake-admin-key-0123456789';

/** Serves identity + ARM admin-key uniformly; delegates blob calls to `onBlob` and search/delete
 *  calls to `onSearch`/`onDelete`. `order` records every call (by a short tag) for sequencing
 *  assertions. */
function buildStub(
  order: string[],
  onBlob: (method: string, url: string, init: RequestInit | undefined) => Response,
  onSearch: (url: string, init: RequestInit | undefined) => Response,
  onDelete: (url: string, init: RequestInit | undefined) => Response,
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (isBlobCall(u)) { order.push(`BLOB:${method}`); return onBlob(method, u, init); }
    if (isIdentityCall(u)) { order.push('IDENTITY'); return new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 }); }
    if (isAdminKeyCall(u)) { order.push('ADMIN_KEY'); return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 }); }
    if (isIndexDocsCall(u)) { order.push('SEARCH_DELETE'); return onDelete(u, init); }
    if (isSearchDocsCall(u)) { order.push('SEARCH_LOOKUP'); return onSearch(u, init); }
    throw new Error(`unexpected call: ${method} ${u}`);
  }) as typeof fetch;
}

function okDelete(): (u: string, init: RequestInit | undefined) => Response {
  return (_u, init) => {
    const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
    return new Response(JSON.stringify({ value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) }), { status: 200 });
  };
}

test('legal_blob_move (configured): de-indexes src_path against the CORRECT container index, AFTER the blob delete, with a confirmed count', async () => {
  const order: string[] = [];
  let headCount = 0;
  let searchLookupBody: Record<string, unknown> | undefined;
  let searchLookupUrl = '';
  const result = await withStubbedFetch(
    buildStub(
      order,
      (method) => {
        if (method === 'HEAD') {
          headCount += 1;
          if (headCount === 1) return new Response(null, { status: 200, headers: { etag: '"src-v1"' } });
          // headCount 2 = the preflight's dst_path check (not yet created); headCount 3+ = the
          // NEW existence-check guard in deindexChunkedPathWithAuth re-checking src_path AFTER the
          // move (2026-08-04, Copilot review round 16) -- src_path is genuinely gone by then (the
          // blob DELETE above already ran), so this must also be 404, not a generic "exists" 200.
          return new Response(null, { status: 404 });
        }
        if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
        if (method === 'DELETE') return new Response(null, { status: 202 });
        throw new Error(`unexpected blob method ${method}`);
      },
      (u, init) => {
        searchLookupUrl = u;
        searchLookupBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'a.pdf' }] }), { status: 200 });
      },
      okDelete(),
    ),
    () => handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal', false)),
  );

  assert.equal((result.data as any).executed, true);
  assert.equal((result.data as any).deindexed, 1, 'the confirmed-deleted chunk count must reach the tool output');
  assert.equal((result.data as any).deindex_truncated, false);

  // The lookup must target `path eq 'a.pdf'` (src_path), never dst_path.
  assert.match(String((searchLookupBody as any)?.filter), /path eq 'a\.pdf'/);

  // 'personal' container maps to the 'legal-personal' index -- pin the ACTUAL index name in the
  // URL, not just "a lookup happened at all" (2026-08-04, Copilot review PR #192 round 4: the
  // prior assertion here would still pass even if the personal/company mapping regressed and this
  // move deleted same-path chunks from the WRONG ring's index).
  assert.match(searchLookupUrl, /\/indexes\/legal-personal\//);
  assert.doesNotMatch(searchLookupUrl, /\/indexes\/legal-company\//);

  // Ordering: the blob DELETE (removing the original from src_path) must happen strictly before
  // the search index delete (cleaning up src_path's stale entry) -- cleanup only makes sense after
  // the move it is cleaning up after has actually happened.
  const blobDeleteIdx = order.indexOf('BLOB:DELETE');
  const searchDeleteIdx = order.indexOf('SEARCH_DELETE');
  assert.ok(blobDeleteIdx >= 0 && searchDeleteIdx >= 0 && blobDeleteIdx < searchDeleteIdx, `expected BLOB:DELETE before SEARCH_DELETE, got order=${order.join(',')}`);

  // Identity + admin key must each be minted exactly once for this single move.
  assert.equal(order.filter((o) => o === 'IDENTITY').length, 1);
  assert.equal(order.filter((o) => o === 'ADMIN_KEY').length, 1);
});

test('legal_blob_move (configured, company container): de-indexes against legal-company, not legal-personal', async () => {
  let searchEndpointHit = '';
  let headCount = 0;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method || 'GET';
      if (isBlobCall(u)) {
        if (method === 'HEAD') {
          headCount += 1;
          if (headCount === 1) return new Response(null, { status: 200, headers: { etag: '"v1"' } });
          // headCount 2 = the preflight's dst_path check; headCount 3+ = the NEW existence-check
          // guard re-checking src_path AFTER the move (2026-08-04, Copilot review round 16) --
          // src_path is genuinely gone by then, so this must be 404 too.
          return new Response(null, { status: 404 });
        }
        if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
        if (method === 'DELETE') return new Response(null, { status: 202 });
      }
      if (isIdentityCall(u)) return new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
      if (isAdminKeyCall(u)) return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 });
      if (isSearchDocsCall(u) || isIndexDocsCall(u)) {
        searchEndpointHit = u;
        if (isSearchDocsCall(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      throw new Error(`unexpected call: ${method} ${u}`);
    }) as typeof fetch,
    () => handleLegalBlobMove({ container: 'company', src_path: 'x.pdf', dst_path: 'y.pdf' }, fakeCtx('clo', false)),
  );
  assert.match(searchEndpointHit, /\/indexes\/legal-company\//);
});

test('legal_blob_delete (configured, bulk): auth resolved ONCE for the whole batch, each moved path looked up, summed confirmed count', async () => {
  const order: string[] = [];
  const lookedUpPaths: string[] = [];
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  const result = await withStubbedFetch(
    buildStub(
      order,
      (method, u) => {
        if (method === 'GET') return new Response(xml, { status: 200 });
        if (method === 'HEAD') return new Response(null, { status: 404 }); // no trash collision
        if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
        if (method === 'DELETE') return new Response(null, { status: 202 });
        throw new Error(`unexpected blob method ${method} ${u}`);
      },
      (_u, init) => {
        const body = JSON.parse(String(init?.body));
        lookedUpPaths.push(String(body.filter).match(/path eq '([^']*)'/)?.[1] ?? '?');
        return new Response(JSON.stringify({ value: [{ chunk_id: `c-${lookedUpPaths.length}`, path: 'x' }] }), { status: 200 });
      },
      okDelete(),
    ),
    () => handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );

  assert.equal((result.data as any).matched, 2);
  assert.equal((result.data as any).moved.length, 2);
  assert.equal((result.data as any).deindexed, 2, 'one confirmed chunk delete per item, summed');
  assert.deepEqual((result.data as any).deindex_incomplete, []);
  assert.deepEqual(lookedUpPaths.sort(), ['dupes/a.pdf', 'dupes/b.pdf'], 'each item\'s ORIGINAL path must be looked up individually');

  // The whole point of prepareDeindexAuth being hoisted out of the loop: exactly one ADMIN-KEY
  // fetch for a 2-item batch, not one per item (Copilot review PR #192: this was the actual
  // regression -- N items previously meant N identical ARM listAdminKeys round trips). The
  // IDENTITY (managed-identity token) call is deliberately NOT asserted here: arm-client.ts's
  // miToken caches that token for the whole PROCESS, so whether it fires 0 or 1 times in this
  // specific test depends on whether an earlier test in this same file already primed the cache
  // (it does, via the blob-move tests above) -- that is a fact about token caching, not about
  // whether THIS handler re-resolves auth per item, which is what admin-key count proves.
  assert.equal(order.filter((o) => o === 'ADMIN_KEY').length, 1);
  assert.equal(order.filter((o) => o === 'SEARCH_LOOKUP').length, 2);
});

test('legal_blob_delete (configured, bulk): a truncated cleanup on one item is reported in deindex_incomplete, not silently dropped', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  let searchCalls = 0;
  const result = await withStubbedFetch(
    buildStub(
      [],
      (method) => {
        if (method === 'GET') return new Response(xml, { status: 200 });
        if (method === 'HEAD') return new Response(null, { status: 404 });
        if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
        if (method === 'DELETE') return new Response(null, { status: 202 });
        throw new Error(`unexpected blob method ${method}`);
      },
      (_u, init) => {
        searchCalls++;
        const body = JSON.parse(String(init?.body));
        // Detect the target path from EITHER query shape: the primary $filter form (`filter: "path
        // eq '...'"`) or the fallback keyword form (`search: '<path>', searchFields: 'path'`) --
        // b.pdf must fail on BOTH forms for this to be a genuine total-lookup-failure simulation,
        // not accidentally "succeed via the fallback" because only the primary shape was matched.
        const path = String(body.filter).match(/path eq '([^']*)'/)?.[1] ?? (body.searchFields === 'path' ? String(body.search) : undefined);
        // a.pdf's index cleanup succeeds; b.pdf's search lookup fails outright (500) on every form.
        if (path === 'dupes/b.pdf') return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path }] }), { status: 200 });
      },
      okDelete(),
    ),
    () => handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((result.data as any).moved.length, 2, 'both blobs must still have moved -- cleanup failure never blocks the actual delete');
  assert.equal((result.data as any).deindexed, 1, 'only a.pdf\'s chunk is confirmed deleted');
  assert.deepEqual((result.data as any).deindex_incomplete, ['dupes/b.pdf'], 'b.pdf\'s incomplete cleanup must be visible, not silently dropped');
  assert.ok(searchCalls >= 2);
});
