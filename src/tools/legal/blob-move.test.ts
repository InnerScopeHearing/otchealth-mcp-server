import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same env preamble as graph-drive/upload.test.ts, plus the legal-store credentials so
// isConfigured() is true and the real (non-"unconfigured") code paths run.
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

const { handleLegalBlobMove } = await import('./blob-move.js');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** Fails loudly if ANY network call happens -- proves a refusal short-circuited before Azure was touched. */
const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
  throw new Error(`UNEXPECTED network call to ${String(url)} -- should have refused before Azure was reached`);
}) as typeof fetch;

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

test('forbidden_ring: a non-clo-personal caller is refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('cfo')),
  );
  assert.equal((res.data as any).error, 'forbidden_ring');
});

test('protected_prefix: src_path under filings/ is refused before any network call, even for an allowed lane', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'filings/2026/petition.pdf', dst_path: 'archive/petition.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'protected_prefix');
});

test('invalid_input: identical src_path and dst_path refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'same.pdf', dst_path: 'same.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'invalid_input');
});

test('src_not_found: refuses when the source blob does not exist (HEAD 404 on src, HEAD 404 on dst)', async () => {
  const stub: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 404 });
    throw new Error(`unexpected call ${init?.method} ${String(url)}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'ghost.pdf', dst_path: 'elsewhere.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'src_not_found');
});

test('dst_exists_no_overwrite: refuses when destination exists and overwrite is not set, WITHOUT ever copying or deleting', async () => {
  const calls: string[] = [];
  const stub: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method} ${u}`);
    if (init?.method === 'HEAD') {
      // both src and dst exist
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected non-HEAD call: ${init?.method} ${u}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'dst_exists_no_overwrite');
  assert.ok(calls.every((c) => c.startsWith('HEAD')), 'only HEAD checks should have run, no PUT/DELETE');
});

test('dry_run (default): reports the plan without ever calling PUT (copy) or DELETE', async () => {
  const calls: string[] = [];
  // src exists (first HEAD -> 200), dst doesn't (second HEAD -> 404): simulate via a counter.
  let n = 0;
  const stub2: typeof fetch = (async (_url: string | URL, init?: RequestInit) => {
    n += 1;
    calls.push(init?.method || 'GET');
    if (init?.method === 'HEAD') return new Response(null, { status: n === 1 ? 200 : 404 });
    throw new Error('unexpected non-HEAD call in dry_run');
  }) as typeof fetch;
  const res = await withStubbedFetch(stub2, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal', true)),
  );
  assert.equal((res.data as any).dry_run, true);
  assert.equal((res.data as any).executed, false);
  assert.ok(!calls.includes('PUT') && !calls.includes('DELETE'), 'dry_run must never PUT or DELETE');
});

test('successful move: copies (PUT with x-ms-copy-source) THEN deletes the original, in that order', async () => {
  const order: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const u = String(url);
    if (method === 'HEAD') {
      headCount += 1;
      order.push('HEAD');
      // 1st HEAD = src exists check (200, with an ETag to pin the copy+delete), 2nd HEAD = dst
      // exists check (404), 3rd HEAD = the post-copy byte-count HEAD on the destination.
      if (headCount === 1) return new Response(null, { status: 200, headers: { etag: '"src-v1"' } });
      if (headCount === 2) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-length': '1234' } });
    }
    if (method === 'PUT') {
      order.push('PUT');
      const h = init?.headers as Record<string, string>;
      assert.ok(h['x-ms-copy-source'], 'PUT must carry x-ms-copy-source for a server-side copy');
      assert.equal(h['x-ms-source-if-match'], '"src-v1"', 'PUT must pin the copy to the source ETag observed just before this call');
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    }
    if (method === 'DELETE') {
      order.push('DELETE');
      assert.equal((init?.headers as Record<string, string>)['If-Match'], '"src-v1"', 'DELETE must pin to the same source ETag the copy used');
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected method ${method} to ${u}`);
  }) as typeof fetch;

  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).executed, true);
  assert.equal((res.data as any).bytes, 1234, 'bytes must come from the post-copy destination HEAD, not the PUT response Content-Length');
  // deindexChunkedPath is called after the move but fails open here (this file's env preamble sets
  // no AZURE_SEARCH_ENDPOINT/IDENTITY_ENDPOINT, mirroring "search unconfigured" in production) --
  // it must never throw, block the move, or trigger any network call beyond the stub above (which
  // throws on anything unexpected, so reaching this assertion already proves that).
  assert.equal((res.data as any).deindexed, 0, 'deindex is best-effort and fails open when search is unconfigured');
  assert.equal((res.data as any).deindex_truncated, true, 'an unconfigured/unattempted deindex is honestly reported as truncated, not silently reported as clean');
  const putIdx = order.indexOf('PUT');
  const delIdx = order.indexOf('DELETE');
  assert.ok(putIdx >= 0 && delIdx >= 0 && putIdx < delIdx, `PUT (copy) must happen strictly before DELETE (remove original); order was ${order.join(',')}`);
});

test('a failed copy NEVER deletes the original (DELETE must not be called if PUT fails)', async () => {
  const order: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (_url: string | URL, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'HEAD') {
      headCount += 1;
      order.push('HEAD');
      return new Response(null, { status: headCount === 1 ? 200 : 404 });
    }
    if (method === 'PUT') {
      order.push('PUT');
      return new Response('server error', { status: 500 });
    }
    if (method === 'DELETE') {
      order.push('DELETE');
      throw new Error('DELETE must never be called when the copy failed');
    }
    throw new Error(`unexpected method ${method}`);
  }) as typeof fetch;

  await assert.rejects(() =>
    withStubbedFetch(stub, () => handleLegalBlobMove({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal', false))),
  );
  assert.ok(!order.includes('DELETE'), 'DELETE must not have been called after a failed copy');
});
