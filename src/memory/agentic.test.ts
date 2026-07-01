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
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { agenticRecall } = await import('./agentic.js');

// Pure network mocking via globalThis.fetch (a genuine global, not a module export). This
// repo's ESM build does not let node:test's mock.method() redefine another module's live named
// export, so agentic.ts's own `embed`/`embedBatch` imports from foundry.js cannot be stubbed
// directly; stubbing the shared transport they both ultimately call is the viable seam here,
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

test('agenticRecall: embeds ALL sub-queries in ONE batched Foundry call, not one embed() call per sub-query', async () => {
  let embeddingsCallCount = 0;
  let searchCallCount = 0;
  let capturedEmbeddingsInput: string[] | undefined;

  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        embeddingsCallCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as { input: string[] }) : { input: [] };
        capturedEmbeddingsInput = body.input;
        return new Response(
          JSON.stringify({
            data: body.input.map((_t, i) => ({ index: i, embedding: [i, i, i] })),
          }),
          { status: 200 },
        );
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
      assert.equal(
        embeddingsCallCount,
        1,
        'the whole batch of sub-queries must be embedded in exactly one Foundry call',
      );
      assert.equal(searchCallCount, 3, 'each sub-query still runs its own AI Search hybrid call');
      assert.deepEqual(
        capturedEmbeddingsInput,
        result.subQueries,
        'the batched embeddings call must carry every sub-query as one array input',
      );
    },
  );
});

test('agenticRecall: a persistently-failing embeddings endpoint still returns hybrid results (falls back to per-sub-query embed(), no crash)', async () => {
  let searchCallCount = 0;

  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) {
        // Every embeddings call (the one batch attempt AND each sub-query's individual embed()
        // fallback) fails, proving the safety net holds even when the whole embeddings path is
        // down, not just the batch call.
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
