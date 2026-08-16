import { test } from 'node:test';
import assert from 'node:assert/strict';

// SEARCH_BACKEND=opensearch, Azure vars UNSET (mirrors src/search/dispatch-opensearch.test.ts).
// Own file = own process under node:test's default per-file isolation. THIS is the file that
// proves the actual defect is closed: before this fix, semantic.ts read AZURE_SEARCH_ENDPOINT /
// AZURE_SEARCH_QUERY_KEY directly, so with those two variables unset (the state they will be in
// once Azure is genuinely retired) it would have returned null unconditionally -- memory_recall's
// second-tier fallback going permanently dark -- regardless of OpenSearch being fully configured
// and reachable.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.SEARCH_BACKEND = 'opensearch';
process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
delete process.env.AZURE_SEARCH_ENDPOINT;
delete process.env.AZURE_SEARCH_QUERY_KEY;

const { semanticSearch, semanticConfigured } = await import('./semantic.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('semanticConfigured: true on OpenSearch with Azure Search vars entirely unset', () => {
  assert.equal(semanticConfigured(), true);
});

test('semanticSearch reaches the OpenSearch domain, not Azure, when SEARCH_BACKEND=opensearch', async () => {
  let hitOpenSearch = false;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/openai/deployments/') && u.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (u.startsWith('https://search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com/memory-exec/_search')) {
        hitOpenSearch = true;
        return new Response(
          JSON.stringify({
            hits: { hits: [{ _id: 'cfo__20260101-042', _score: 4.2, _source: { text: 'hello from opensearch', type: 'fact' } }] },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch (semanticSearch should not reach a non-opensearch host when SEARCH_BACKEND=opensearch): ${u}`);
    }) as typeof fetch,
    async () => {
      const hits = await semanticSearch('test query', null, 10);
      assert.ok(hits, 'expected a non-null result -- null would mean this silently fell through to the (unconfigured) Azure client');
      assert.equal(hitOpenSearch, true, 'the search must land on the OpenSearch domain host, not an Azure endpoint');
      assert.equal(hits!.length, 1);
      assert.equal(hits![0]!.text, 'hello from opensearch');
      assert.equal(hits![0]!.agent, 'cfo', 'agent recovery from the doc-id prefix must work on the OpenSearch path too');
    },
  );
});
