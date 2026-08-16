import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so WEB_SEARCH_PROVIDER must be settled BEFORE
// this file's first loadEnv() call.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.WEB_SEARCH_PROVIDER = 'tavily';
process.env.TAVILY_API_KEY = 'tvly-test-key';
// Azure stays FULLY configured here on purpose -- mirrors chat-provider-unconfigured.test.ts's
// discipline: proves WEB_SEARCH_PROVIDER=tavily does not fall back to a configured Azure, and never
// calls it, even though it could.
process.env.WEBSEARCH_PROJECT_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.WEBSEARCH_SP_TENANT_ID = 'test-tenant';
process.env.WEBSEARCH_SP_CLIENT_ID = 'test-client';
process.env.WEBSEARCH_SP_SECRET = 'test-secret';

const { resolveWebSearchProvider, runWebSearch } = await import('./web-search.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('WEB_SEARCH_PROVIDER=tavily resolves to "tavily"', () => {
  assert.equal(resolveWebSearchProvider(), 'tavily');
});

test('runWebSearch() hits Tavily, never Azure, even though Azure is fully configured too', async () => {
  const calls: string[] = [];
  const result = await withStubbedFetch(
    (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ answer: 'answer from tavily', results: [{ title: 'a source', url: 'https://example.com' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => runWebSearch('anything'),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.answer, 'answer from tavily');
  assert.deepEqual(result.citations, [{ title: 'a source', url: 'https://example.com' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://api.tavily.com/search');
  assert.equal(
    calls.some((u) => u.includes('microsoftonline.com') || u.includes('openai/v1/responses')),
    false,
    'must never call Azure while WEB_SEARCH_PROVIDER=tavily',
  );
});
