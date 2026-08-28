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

const { handleLegalBlobCopy } = await import('./blob-copy.js');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
  throw new Error(`UNEXPECTED network call to ${String(url)} -- should have refused before Azure was reached`);
}) as typeof fetch;

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

test('forbidden_ring: a non-clo-personal caller is refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobCopy({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('cfo')),
  );
  assert.equal((res.data as any).error, 'forbidden_ring');
});

test('copy does NOT check protected prefixes -- a copy FROM a protected src is allowed (additive, non-destructive)', async () => {
  let headCount = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'HEAD') {
      headCount += 1;
      // 1: src exists, 2: dst doesn't, 3: post-copy byte-count HEAD.
      if (headCount === 1) return new Response(null, { status: 200 });
      if (headCount === 2) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-length': '99' } });
    }
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobCopy({ container: 'personal', src_path: 'filings/2026/petition.pdf', dst_path: 'organized/petition.pdf' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).executed, true);
  assert.equal((res.data as any).bytes, 99);
});

test('dst_exists_no_overwrite: refuses without ever calling PUT', async () => {
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 200 }); // both exist
    throw new Error('must not PUT');
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobCopy({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'dst_exists_no_overwrite');
});

test('successful copy: original is never touched with DELETE, and the copy PUT is pinned to the source ETag', async () => {
  let headCount = 0;
  const calls: string[] = [];
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push(method);
    if (method === 'HEAD') {
      headCount += 1;
      if (headCount === 1) return new Response(null, { status: 200, headers: { etag: '"v1"' } });
      if (headCount === 2) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-length': '42' } });
    }
    if (method === 'PUT') {
      assert.equal((init?.headers as Record<string, string>)['x-ms-source-if-match'], '"v1"');
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    }
    if (method === 'DELETE') throw new Error('legal_blob_copy must NEVER call DELETE');
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobCopy({ container: 'personal', src_path: 'a.pdf', dst_path: 'b.pdf' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).executed, true);
  assert.equal((res.data as any).bytes, 42);
  assert.ok(!calls.includes('DELETE'));
});
