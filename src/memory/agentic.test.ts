import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (foundry.ts's cfg() goes through loadEnv), then configure
// both Foundry and Azure AI Search so agenticRecall's real code paths (not the 'unconfigured'
// early return) run.
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
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { agenticRecall } = await import('./agentic.js');

// Pure network mocking via globalThis.fetch (a genuine global, not a module export). This
// repo's ESM build does not let node:test's mock.method() redefine another module's live named
// export, so agentic.ts's own dispatcher import from search/index.js cannot be stubbed
// directly; stubbing the shared transport it ultimately calls is the viable seam here,
// the same approach as src/util/fetch-budget.test.ts and src/azure/foundry.test.ts.
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

test('agenticRecall: routes each sub-query through the shared search dispatcher (one embed() + one search per sub-query)', async () => {
  // FIXED 2026-08-16: agentic.ts used to batch-embed every sub-query in ONE Foundry call (via its
  // own hand-rolled fetch client that read AZURE_SEARCH_ENDPOINT directly), which is exactly the
  // kind of Azure-only bypass this change closes. Routing through src/search/index.ts's shared
  // hybridSearch() means each sub-query embeds independently (the dispatcher has no parameter to
  // accept a precomputed vector) -- a deliberate, documented, bounded tradeoff (agentic.ts's file
  // header) in exchange for SEARCH_BACKEND actually being honoured. This test pins the NEW shape
  // so a future change is forced to re-justify it rather than silently drifting.
  let embeddingsCallCount = 0;
  let searchCallCount = 0;

  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        embeddingsCallCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as { input: string | string[] }) : { input: '' };
        // The dispatcher's embed() sends a single string per call now, not a batched array.
        assert.equal(typeof body.input, 'string', 'each sub-query must be embedded in its own call, not a shared batch');
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
      }
      if (isSearchUrl(u)) {
        searchCallCount++;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      // "and" splits this into 3 sub-queries: the full query, "deploy status", "PostHog usage".
      const result = await agenticRecall('deploy status and PostHog usage');
      assert.equal(result.mode, 'agentic-hybrid');
      assert.equal(result.subQueries.length, 3, 'sanity check: this query should plan 3 sub-queries');
      assert.equal(embeddingsCallCount, 3, 'each of the 3 sub-queries embeds independently through the dispatcher');
      assert.equal(searchCallCount, 3, 'each sub-query still runs its own AI Search hybrid call');
    },
  );
});

test('agenticRecall: a persistently-failing embeddings endpoint still returns hybrid results (falls back to keyword-only per sub-query, no crash)', async () => {
  let searchCallCount = 0;

  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        // Every embeddings call fails, proving the dispatcher's own fail-open (embed() throws ->
        // caught inside azure/search.ts's runHybridSearch -> vector stays null -> keyword+semantic
        // search still runs) holds when reached through agentic.ts.
        return new Response('internal error', { status: 500 });
      }
      if (isSearchUrl(u)) {
        searchCallCount++;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const result = await agenticRecall('deploy status and PostHog usage');
      assert.equal(result.mode, 'agentic-hybrid', 'a fully-broken embeddings path must not crash agenticRecall');
      assert.equal(
        searchCallCount,
        3,
        'each of the 3 sub-queries must still run its own AI Search (keyword+semantic, no vector) call',
      );
    },
  );
});

test('agenticRecall: recovers `agent` from the {agent}__{id} doc-id prefix and applies the client-side agent filter', async () => {
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
              { id: 'cto__1', text: 'cto fact', type: 'fact', '@search.rerankerScore': 3 },
              { id: 'cfo__2', text: 'cfo fact', type: 'fact', '@search.rerankerScore': 2 },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const unfiltered = await agenticRecall('status update');
      assert.ok(unfiltered.results.length > 0);
      assert.ok(
        unfiltered.results.some((h) => h.agent === 'cto') && unfiltered.results.some((h) => h.agent === 'cfo'),
        'agent must be recovered from the doc-id prefix for every hit',
      );

      const filtered = await agenticRecall('status update', { agent: 'cto' });
      assert.ok(filtered.results.length > 0);
      assert.ok(filtered.results.every((h) => h.agent === 'cto'), 'the agent option must filter client-side on the recovered agent');
    },
  );
});
