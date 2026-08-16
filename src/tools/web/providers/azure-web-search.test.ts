import { test } from 'node:test';
import assert from 'node:assert/strict';
import { azureWebSearch, azureWebSearchConfigured, __resetAadTokenCacheForTests } from './azure-web-search.js';

// This module reads process.env.WEBSEARCH_* directly (not through loadEnv()/config/env.ts -- see
// its own header), so there is no per-process parse-cache to fight here: ordinary per-test env
// mutation is safe as long as each test is explicit about what it sets, and clears afterward so one
// test's configuration never leaks into the next. node:test runs a file's tests sequentially by
// default, which this suite relies on.
const AZURE_VARS = [
  'WEBSEARCH_PROJECT_ENDPOINT',
  'WEBSEARCH_SP_TENANT_ID',
  'WEBSEARCH_SP_CLIENT_ID',
  'WEBSEARCH_SP_SECRET',
  'WEBSEARCH_MODEL',
] as const;
function clearAzureEnv(): void {
  for (const k of AZURE_VARS) delete process.env[k];
}
function setAzureEnv(): void {
  process.env.WEBSEARCH_PROJECT_ENDPOINT = 'https://otchealth-foundry.example.invalid';
  process.env.WEBSEARCH_SP_TENANT_ID = 'test-tenant';
  process.env.WEBSEARCH_SP_CLIENT_ID = 'test-client';
  process.env.WEBSEARCH_SP_SECRET = 'test-secret';
}

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('azureWebSearchConfigured() is false with no WEBSEARCH_* env set', () => {
  clearAzureEnv();
  assert.equal(azureWebSearchConfigured(), false);
});

test('azureWebSearch() returns a clearly-labeled unconfigured result, NOT a silent empty web result', async () => {
  clearAzureEnv();
  const result = await azureWebSearch('anything');
  assert.equal(result.mode, 'unconfigured');
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
  assert.equal(result.error, undefined);
});

test('azureWebSearchConfigured() is true once endpoint + client + secret are all set', () => {
  setAzureEnv();
  assert.equal(azureWebSearchConfigured(), true);
  clearAzureEnv();
});

test('a successful search mints an AAD token, then parses output_text + annotations into citations', async () => {
  setAzureEnv();
  __resetAadTokenCacheForTests();
  const calls: string[] = [];
  const result = await withStubbedFetch(
    (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fake-aad-token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output_text: 'AAPL closed at $250.',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'AAPL closed at $250.',
                  annotations: [{ url: 'https://example.com/aapl', title: 'AAPL quote' }],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => azureWebSearch('AAPL stock price'),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.answer, 'AAPL closed at $250.');
  assert.deepEqual(result.citations, [{ title: 'AAPL quote', url: 'https://example.com/aapl' }]);
  assert.equal(calls.some((u) => u.includes('login.microsoftonline.com')), true);
  assert.equal(calls.some((u) => u.includes('/openai/v1/responses')), true);
  clearAzureEnv();
});

test('an AAD token failure surfaces as mode:"error", never a thrown exception', async () => {
  setAzureEnv();
  __resetAadTokenCacheForTests();
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as unknown as typeof fetch,
    () => azureWebSearch('anything'),
  );
  assert.equal(result.mode, 'error');
  assert.match(result.error ?? '', /invalid_client|401/);
  clearAzureEnv();
});

test('a non-2xx from the Responses API surfaces the status + a body snippet in `error`', async () => {
  setAzureEnv();
  __resetAadTokenCacheForTests();
  let call = 0;
  const result = await withStubbedFetch(
    (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response('rate limited, try again later', { status: 429 });
    }) as unknown as typeof fetch,
    () => azureWebSearch('anything'),
  );
  assert.equal(result.mode, 'error');
  assert.match(result.error ?? '', /429/);
  assert.match(result.error ?? '', /rate limited/);
  clearAzureEnv();
});

test('a network failure on the search call itself surfaces as a bounded timeout error, never a thrown exception', async () => {
  setAzureEnv();
  __resetAadTokenCacheForTests();
  let call = 0;
  const result = await withStubbedFetch(
    (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    () => azureWebSearch('anything'),
  );
  assert.equal(result.mode, 'error');
  assert.equal(result.error, 'web_search timeout');
  clearAzureEnv();
});

test('the answer is capped at 4000 characters', async () => {
  setAzureEnv();
  __resetAadTokenCacheForTests();
  const longText = 'x'.repeat(5000);
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (String(url).includes('login.microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ output_text: longText, output: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => azureWebSearch('anything'),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.answer.length, 4000);
  clearAzureEnv();
});
