import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same preamble as search.test.ts — satisfies loadEnv()'s required vars, then configures Azure AI
// Search so getDocumentByKey's real code paths (not an early-unconfigured return) run below.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { getDocumentByKey } = await import('./search.js');

// Pure network mocking via globalThis.fetch — same seam as search.test.ts.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isGetByKeyUrl(url: string): boolean {
  return url.includes('/docs/') && !url.includes('/docs/search');
}

function isChunkSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}

// --- flat rooms: direct GET-by-key --------------------------------------------------------------

test('getDocumentByKey (flat room): a direct GET returns title/text/path, mode "direct"', async () => {
  let capturedUrl: string | undefined;
  let capturedMethod: string | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      capturedUrl = u;
      capturedMethod = init?.method;
      if (isGetByKeyUrl(u)) {
        return new Response(JSON.stringify({ id: 'cto__142', title: 'ASC key doc', text: 'the ASC key id is 9MR7PJHRYH', path: undefined }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('memory-exec', 'cto__142');
      assert.ok(doc);
      assert.equal(doc!.mode, 'direct');
      assert.equal(doc!.key, 'cto__142');
      assert.equal(doc!.title, 'ASC key doc');
      assert.equal(doc!.text, 'the ASC key id is 9MR7PJHRYH');
      assert.equal(capturedMethod, 'GET');
      assert.ok(capturedUrl!.includes('/indexes/memory-exec/docs/cto__142'));
    },
  );
});

test('getDocumentByKey (flat room): a 404 returns null, never throws', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isGetByKeyUrl(u)) return new Response('not found', { status: 404 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('memory-exec', 'does-not-exist');
      assert.equal(doc, null);
    },
  );
});

test('getDocumentByKey (flat room): a real 500 throws (not silently swallowed)', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isGetByKeyUrl(u)) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(() => getDocumentByKey('memory-exec', 'x'), /getDocumentByKey 500/);
    },
  );
});

test('getDocumentByKey: an empty key returns null with NO network call at all', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      throw new Error(`unexpected fetch to ${String(url)} — an empty key must short-circuit before any request`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('memory-exec', '');
      assert.equal(doc, null);
    },
  );
});

// --- chunked rooms: parent reassembly -------------------------------------------------------------

const P1_CHUNKS = [
  { chunk_id: 'p1#0', parent_id: 'p1', title: 'Contract A', path: 'legal/contractA.pdf', chunk: 'chunk zero of contract A' },
  { chunk_id: 'p1#2', parent_id: 'p1', title: 'Contract A', path: 'legal/contractA.pdf', chunk: 'chunk two of contract A' },
  { chunk_id: 'p1#1', parent_id: 'p1', title: 'Contract A', path: 'legal/contractA.pdf', chunk: 'chunk one of contract A' },
];

test('getDocumentByKey (chunked room): reassembles chunks in chunk-ordinal order via the parent_id filter, mode "reassembled"', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: P1_CHUNKS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('legal-company', 'p1');
      assert.ok(doc);
      assert.equal(doc!.mode, 'reassembled');
      assert.equal(doc!.key, 'p1');
      assert.equal(doc!.title, 'Contract A');
      assert.equal(doc!.path, 'legal/contractA.pdf');
      assert.equal(doc!.text, 'chunk zero of contract A\n\nchunk one of contract A\n\nchunk two of contract A', 'chunks are ordered 0,1,2 regardless of response order');
      assert.equal(capturedBody?.filter, "parent_id eq 'p1'");
      assert.equal(capturedBody?.select, 'chunk_id,parent_id,title,path,chunk');
    },
  );
});

test('getDocumentByKey (chunked room): a single-quote in the key is OData-escaped in the filter', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await getDocumentByKey('legal-company', "o'brien");
      assert.equal(capturedBody?.filter, "parent_id eq 'o''brien'");
    },
  );
});

test('getDocumentByKey (chunked room): a 400 on the filtered attempt falls back ONCE to an exact-matched keyword query', async () => {
  let callCount = 0;
  const bodies: Array<Record<string, unknown>> = [];
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) {
        callCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        bodies.push(body);
        if (callCount === 1) return new Response(JSON.stringify({ error: { message: 'parent_id is not filterable' } }), { status: 400 });
        // The fallback keyword attempt returns a mix: the right parent's chunks PLUS an unrelated
        // document's chunk that happens to keyword-match — the exact client-side filter must drop it.
        return new Response(
          JSON.stringify({
            value: [...P1_CHUNKS, { chunk_id: 'p2#0', parent_id: 'p2', title: 'Contract B', path: 'legal/contractB.pdf', chunk: 'unrelated chunk' }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('legal-company', 'p1');
      assert.ok(doc, 'a 400 on the filter must degrade gracefully, never throw');
      assert.equal(callCount, 2, 'exactly one retry: filtered attempt + keyword fallback');
      assert.equal(bodies[1]?.filter, undefined, 'the fallback body carries no filter');
      assert.equal(bodies[1]?.queryType, 'simple');
      assert.equal(doc!.mode, 'reassembled');
      assert.ok(doc!.text.includes('contract A'));
      assert.ok(!doc!.text.includes('unrelated chunk'), 'the exact client-side match must drop the unrelated parent p2 chunk');
    },
  );
});

test('getDocumentByKey (chunked room): a thrown network error on the filtered attempt falls back once, same as a 400', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) {
        callCount++;
        if (callCount === 1) throw new TypeError('network blip');
        return new Response(JSON.stringify({ value: P1_CHUNKS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('legal-company', 'p1');
      assert.ok(doc, 'a thrown error on the filtered attempt must not propagate as a fetch failure');
      assert.equal(doc!.mode, 'reassembled');
    },
  );
});

test('getDocumentByKey (chunked room): no matching chunks returns null', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) return new Response(JSON.stringify({ value: [] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const doc = await getDocumentByKey('legal-company', 'no-such-parent');
      assert.equal(doc, null);
    },
  );
});

test('getDocumentByKey (chunked room): a non-400, non-ok response (e.g. 500) still throws', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isChunkSearchUrl(u)) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(() => getDocumentByKey('legal-company', 'p1'), /getDocumentByKey 500/);
    },
  );
});
