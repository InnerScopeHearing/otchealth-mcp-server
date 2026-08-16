import { test } from 'node:test';
import assert from 'node:assert/strict';

// Required-var preamble + Azure Search configured (mirrors src/search/dispatch-azure.test.ts).
// Own file = own process under node:test's default per-file isolation, so this scenario's env and
// loadEnv()'s module-scoped cache are never contaminated by semantic-opensearch.test.ts's opposite
// configuration in the same run.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';
delete process.env.SEARCH_BACKEND; // default 'azure'
delete process.env.OPENSEARCH_ENDPOINT;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

const { semanticSearch, semanticConfigured } = await import('./semantic.js');

// Pure network mocking via globalThis.fetch — the same seam agentic.test.ts / azure/search.test.ts /
// search/dispatch-azure.test.ts use.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isEmbeddingsUrl(url: string): boolean {
  return url.includes('/openai/deployments/') && url.includes('/embeddings');
}
function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}

test('semanticConfigured mirrors the dispatcher (true once the active backend -- here Azure -- is configured)', () => {
  assert.equal(semanticConfigured(), true);
});

test('semanticSearch routes through the shared dispatcher: reaches Azure AI Search AND embeds the query', async () => {
  // This is the core regression proof: the OLD implementation built its own queryType:'simple'
  // body and never sent a vector at all despite the module's name. Going through the dispatcher
  // means every query is genuinely embedded (EMBEDDINGS_PROVIDER-aware) and hybrid-searched.
  let embeddingsCallCount = 0;
  let searchCallCount = 0;
  let capturedSearchBody: Record<string, unknown> | undefined;

  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        embeddingsCallCount++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      }
      if (isSearchUrl(u)) {
        searchCallCount++;
        capturedSearchBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
        return new Response(
          JSON.stringify({
            value: [{ id: 'cto__20260101-001', text: 'a fact', type: 'fact', '@search.rerankerScore': 2.5 }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const hits = await semanticSearch('deploy status', null, 10);
      assert.ok(hits, 'expected a non-null result');
      assert.equal(embeddingsCallCount, 1, 'the query must be embedded -- the old body never sent a vector at all');
      assert.equal(searchCallCount, 1);
      assert.ok(capturedSearchBody, 'expected the search request body to have been captured');
      assert.ok(
        Array.isArray(capturedSearchBody!.vectorQueries),
        'the search body must carry the embedded query vector',
      );
      assert.equal(hits!.length, 1);
      assert.equal(hits![0]!.id, 'cto__20260101-001');
      assert.equal(hits![0]!.text, 'a fact');
      assert.equal(hits![0]!.type, 'fact');
      assert.equal(hits![0]!.agent, 'cto', 'agent must be recovered from the {agent}__{id} doc-id prefix');
      assert.equal(hits![0]!.score, 2.5);
    },
  );
});

test('semanticSearch: client-side agent filter matches on the id-derived agent lane', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (isSearchUrl(u)) {
        return new Response(
          JSON.stringify({
            value: [
              { id: 'cto__1', text: 'cto fact', '@search.rerankerScore': 3 },
              { id: 'cfo__2', text: 'cfo fact', '@search.rerankerScore': 2 },
              { id: 'cto__3', text: 'another cto fact', '@search.rerankerScore': 1 },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const hits = await semanticSearch('deploy status', 'cto', 10);
      assert.ok(hits);
      assert.equal(hits!.length, 2, 'only the two cto-lane hits should survive the client-side filter');
      assert.ok(hits!.every((h) => h.agent === 'cto'));
    },
  );
});

test('semanticSearch: an id with no {agent}__ prefix degrades to an empty agent rather than throwing', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
      }
      if (isSearchUrl(u)) {
        return new Response(JSON.stringify({ value: [{ id: 'no-delimiter-here', text: 'x', '@search.score': 1 }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const hits = await semanticSearch('q', null, 10);
      assert.ok(hits);
      assert.equal(hits!.length, 1);
      assert.equal(hits![0]!.agent, '');
    },
  );
});
