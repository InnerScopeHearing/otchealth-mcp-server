import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so every env var this file's tests depend on
// must be settled BEFORE that first call, matching web-search-provider-tavily.test.ts's discipline
// and this directory's web-research.test.ts sibling. One fixed governance config for the WHOLE
// file (domain-governance.test.ts and tavily-web-extract.test.ts already cover governance parsing
// and allow/deny precedence exhaustively as a pure function of an explicit `gov` argument -- this
// file's job is only to prove runWebExtract() actually WIRES env into that already-proven logic).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.TAVILY_API_KEY = 'tvly-test-key';
process.env.WEB_SEARCH_DOMAIN_ALLOW = 'good.example';
process.env.WEB_SEARCH_DOMAIN_DENY = 'evil.example';

const { runWebExtract } = await import('./web-extract.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('runWebExtract() reads TAVILY_API_KEY from env and sends it as a bearer token', async () => {
  let seenAuth = '';
  const result = await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      return new Response(JSON.stringify({ results: [{ url: 'https://good.example/a', raw_content: 'x' }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://good.example/a'] }),
  );
  assert.equal(seenAuth, 'Bearer tvly-test-key');
  assert.equal(result.mode, 'web');
});

test('runWebExtract() reads WEB_SEARCH_DOMAIN_ALLOW/_DENY from env and applies it as a PRE-filter -- a denied URL never reaches the request body', async () => {
  let seenBody: Record<string, unknown> = {};
  const result = await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [{ url: 'https://good.example/a', raw_content: 'ok' }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://good.example/a', 'https://evil.example/b'] }),
  );
  assert.deepEqual(seenBody.urls, ['https://good.example/a'], 'the env-denied URL must never leave the gateway');
  assert.equal(result.mode, 'web');
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0]?.url, 'https://evil.example/b');
});

test('runWebExtract() reads WEB_SEARCH_DOMAIN_ALLOW/_DENY from env: EVERY url denied -> mode:"domain_blocked", Tavily never called', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://evil.example/a'] }),
  );
  assert.equal(fetchCalled, false);
  assert.equal(result.mode, 'domain_blocked');
});

test('runWebExtract() passes the optional query reranking hint through to Tavily', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://good.example/a'], query: 'the relevant section' }),
  );
  assert.equal(seenBody.query, 'the relevant section');
});

test('runWebExtract() omits query entirely from the request body when not supplied', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://good.example/a'] }),
  );
  assert.equal('query' in seenBody, false);
});

test('runWebExtract() surfaces failed extractions alongside successful results in one call', async () => {
  const result = await withStubbedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          results: [{ url: 'https://good.example/a', raw_content: 'ok' }],
          failed_results: [{ url: 'https://good.example/b', error: 'timeout' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => runWebExtract({ urls: ['https://good.example/a', 'https://good.example/b'] }),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.results.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.url, 'https://good.example/b');
});
