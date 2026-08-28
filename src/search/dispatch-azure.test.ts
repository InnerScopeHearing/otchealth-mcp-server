import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file = own process under node:test's default per-file isolation, so this file's SEARCH_BACKEND
// (explicitly 'azure') and config are never contaminated by dispatch-opensearch.test.ts's opposite
// configuration in the same run, and loadEnv()'s module-scoped cache is never shared across the two
// scenarios.
//
// CORRECTED 2026-08-28: SEARCH_BACKEND's schema default flipped 'azure' -> 'opensearch' (env.ts;
// Azure subscription 55c84f6b was permanently deleted 2026-08-13). This file's own purpose was
// always "prove the Azure dispatch path works", not "prove what the default is" (that assertion
// belongs to search/index.test.ts, updated separately) -- so it now pins SEARCH_BACKEND=azure
// EXPLICITLY rather than relying on it being the unset default, and keeps testing the identical
// Azure REST surface it always did. The Azure path stays inert-but-present (see arm-client.ts's
// header) and still needs this coverage.
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
process.env.SEARCH_BACKEND = 'azure';
delete process.env.OPENSEARCH_ENDPOINT;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

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

test('dispatcher default (SEARCH_BACKEND unset): searchConfigured mirrors the Azure client only', () => {
  assert.equal(searchConfigured(), true); // AZURE_SEARCH_* set above, OPENSEARCH_ENDPOINT unset
});

test('dispatcher default: hybridSearch reaches the Azure AI Search REST surface, not OpenSearch', async () => {
  let hitAzureUrl = false;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/openai/deployments/') && u.includes('/embeddings')) {
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
      if (u.includes('otchealth-dataroom-search.example.invalid') && u.includes('/docs/search')) {
        hitAzureUrl = true;
        return new Response(JSON.stringify({ value: [{ id: '1', text: 'hello from azure', '@search.rerankerScore': 1.0 }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch (dispatcher should not reach a non-azure host by default): ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'test query', 5);
      assert.ok(res);
      assert.equal(hitAzureUrl, true, 'the default dispatch must land on the Azure AI Search endpoint');
      assert.equal(res!.matches[0]?.text, 'hello from azure');
    },
  );
});
