import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so TAVILY_API_KEY must be unset BEFORE this
// file's first loadEnv() call to prove the "selected but unconfigured" path (mutating process.env
// mid-file has no effect once the cache is warm -- see chat-provider-unconfigured.test.ts's own
// header for the identical trap on LLM_PROVIDER/OPENAI_API_KEY).
//
// THIS IS THE CORE REGRESSION TEST for the failure mode the task brief calls out by name: "fail-open
// to a clear 'unconfigured' result, never a silent empty success that reads as 'no results found' --
// a failure mode this fleet has been bitten by repeatedly."
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.WEB_SEARCH_PROVIDER = 'tavily';
process.env.TAVILY_API_KEY = ''; // deliberately unset

const { resolveWebSearchProvider, runWebSearch } = await import('./web-search.js');

test('WEB_SEARCH_PROVIDER=tavily with no TAVILY_API_KEY still resolves the provider correctly...', () => {
  assert.equal(resolveWebSearchProvider(), 'tavily');
});

test('...but runWebSearch() returns a clearly-labeled "unconfigured" result, NEVER a silent empty "web" success, and never calls the network', async () => {
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  let result;
  try {
    result = await runWebSearch('this must not silently read as "searched, found nothing"');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(result.mode, 'unconfigured');
  assert.notEqual(
    result.mode,
    'web',
    'an unconfigured provider must NEVER report mode:"web" -- that is the exact silent-empty-success class this contract exists to prevent',
  );
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
  assert.equal(fetchCalled, false, 'an unconfigured provider must never make a network call');
});
