import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- see dispatch-azure.test.ts's header for why this matters.
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

const { hybridSearch, searchConfigured } = await import('./index.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('dispatcher SEARCH_BACKEND=opensearch: searchConfigured mirrors the OpenSearch client only', () => {
  assert.equal(searchConfigured(), true); // OPENSEARCH_ENDPOINT + AWS creds set, AZURE_SEARCH_* unset
});

test('dispatcher SEARCH_BACKEND=opensearch: hybridSearch reaches the OpenSearch domain, not Azure', async () => {
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
          JSON.stringify({ hits: { hits: [{ _id: 'doc-1', _score: 4.2, _source: { text: 'hello from opensearch', type: 'fact' } }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch (dispatcher should not reach a non-opensearch host when SEARCH_BACKEND=opensearch): ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'test query', 5);
      assert.ok(res, 'expected a non-null result -- a null here would mean the dispatcher silently fell through to the (unconfigured) Azure client');
      assert.equal(hitOpenSearch, true, 'the opensearch dispatch must land on the OpenSearch domain host');
      assert.equal(res!.matches[0]?.text, 'hello from opensearch');
    },
  );
});
