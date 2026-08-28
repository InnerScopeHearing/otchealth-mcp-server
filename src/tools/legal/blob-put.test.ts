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

const { handleLegalBlobPut, legalBlobPutInputShape } = await import('./blob-put.js');

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
  return {
    correlationId: 'test-corr',
    callerHash: 'test-hash',
    dryRun,
    acknowledgeWarning: false,
    callerAgent,
  };
}

test('input contract exposes base64 and does not expose deprecated content_base64', () => {
  const keys = Object.keys(legalBlobPutInputShape);
  assert.ok(keys.includes('base64'));
  assert.ok(!keys.includes('content_base64'));
});

test('forbidden ring is rejected before storage access', async () => {
  const result = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobPut(
      { container: 'personal', path: 'synthetic.pdf', base64: Buffer.from('synthetic').toString('base64') },
      fakeCtx('cfo'),
    ),
  );
  assert.equal((result.data as any).error, 'forbidden_ring');
});

test('dry_run with base64 performs HEAD only and never uploads', async () => {
  const methods: string[] = [];
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    methods.push(method);
    if (method === 'HEAD') return new Response(null, { status: 404 });
    throw new Error(`dry_run must not execute ${method}`);
  }) as typeof fetch;
  const result = await withStubbedFetch(stub, () =>
    handleLegalBlobPut(
      {
        container: 'personal',
        path: 'synthetic.pdf',
        base64: Buffer.from('synthetic-binary').toString('base64'),
        content_type: 'application/pdf',
      },
      fakeCtx('clo-personal', true),
    ),
  );
  assert.deepEqual(methods, ['HEAD']);
  assert.equal((result.data as any).executed, false);
  assert.equal((result.data as any).dry_run, true);
});

test('dry_run=false with base64 performs one conditional PUT with decoded bytes', async () => {
  const methods: string[] = [];
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    methods.push(method);
    if (method === 'HEAD') return new Response(null, { status: 404 });
    if (method === 'PUT') {
      assert.equal(Buffer.from(init?.body as Buffer).toString('utf8'), 'synthetic-binary');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers['Content-Type'], 'application/pdf');
      assert.equal(headers['If-None-Match'], '*');
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const result = await withStubbedFetch(stub, () =>
    handleLegalBlobPut(
      {
        container: 'personal',
        path: 'synthetic.pdf',
        base64: Buffer.from('synthetic-binary').toString('base64'),
        content_type: 'application/pdf',
      },
      fakeCtx('clo-personal', false),
    ),
  );
  assert.deepEqual(methods, ['HEAD', 'PUT']);
  assert.equal((result.data as any).executed, true);
  assert.equal((result.data as any).dry_run, false);
  assert.equal((result.data as any).bytes, 16);
});
