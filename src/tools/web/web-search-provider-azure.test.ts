import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so WEB_SEARCH_PROVIDER must be settled BEFORE
// this file's first loadEnv() call. Mirrors src/azure/chat-provider.test.ts's exact discipline for
// LLM_PROVIDER.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Deliberately do NOT set WEB_SEARCH_PROVIDER -- proves the documented default is 'azure' without
// relying on an explicit value anywhere in this file.
// TAVILY_API_KEY IS set here on purpose: proves provider selection is driven by the FLAG, not by
// which credentials happen to exist (the same discipline chat-provider.test.ts uses for
// LLM_PROVIDER/FOUNDRY_* -- "the chat provider is chosen by LLM_PROVIDER, not by which credentials
// exist").
process.env.TAVILY_API_KEY = 'tvly-should-never-be-called';
process.env.WEBSEARCH_PROJECT_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.WEBSEARCH_SP_TENANT_ID = 'test-tenant';
process.env.WEBSEARCH_SP_CLIENT_ID = 'test-client';
process.env.WEBSEARCH_SP_SECRET = 'test-secret';

const { resolveWebSearchProvider, runWebSearch } = await import('./web-search.js');
const { __resetAadTokenCacheForTests } = await import('./providers/azure-web-search.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('WEB_SEARCH_PROVIDER unset resolves to the documented default, "azure"', () => {
  assert.equal(resolveWebSearchProvider(), 'azure');
});

test('runWebSearch() hits the Azure Foundry endpoint, never Tavily, even though TAVILY_API_KEY is also set', async () => {
  __resetAadTokenCacheForTests();
  const calls: string[] = [];
  const result = await withStubbedFetch(
    (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ output_text: 'answer from azure', output: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebSearch('anything'),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.answer, 'answer from azure');
  assert.equal(calls.some((u) => u.includes('api.tavily.com')), false, 'must never call Tavily while WEB_SEARCH_PROVIDER=azure (the default)');
  assert.equal(calls.some((u) => u.includes('/openai/v1/responses')), true);
});
