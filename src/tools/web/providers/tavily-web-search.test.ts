import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tavilyWebSearch, tavilyWebSearchConfigured } from './tavily-web-search.js';
import { NO_DOMAIN_GOVERNANCE } from '../domain-governance.js';

// This module takes its API key as a plain function argument (not through loadEnv()) precisely so
// it is testable like this, with no per-process env-parse cache to work around.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('tavilyWebSearchConfigured() is false for an empty key, true for a non-empty one', () => {
  assert.equal(tavilyWebSearchConfigured(''), false);
  assert.equal(tavilyWebSearchConfigured('tvly-abc123'), true);
});

test('an empty API key returns a clearly-labeled unconfigured result, NOT a silent empty web result -- and never calls fetch at all', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', ''),
  );
  assert.equal(result.mode, 'unconfigured');
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
  assert.equal(result.error, undefined);
  assert.equal(fetchCalled, false, 'an unconfigured provider must never make a network call');
});

test('a successful search hits api.tavily.com/search with a bearer token and maps answer + results into the drop-in shape', async () => {
  let seenUrl = '';
  let seenAuth = '';
  let seenBody: Record<string, unknown> = {};
  const result = await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      seenBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          answer: 'The current InnerScope Hearing Technologies ticker is INND.',
          results: [
            { title: 'InnerScope Hearing Technologies (INND)', url: 'https://example.com/innd' },
            { title: 'a result with no url is still a valid citation by title' },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('INND ticker', 'tvly-test-key'),
  );
  assert.equal(seenUrl, 'https://api.tavily.com/search');
  assert.equal(seenAuth, 'Bearer tvly-test-key');
  assert.equal(seenBody.query, 'INND ticker');
  assert.equal(seenBody.include_answer, 'basic');
  assert.equal(seenBody.search_depth, 'basic');
  assert.equal(result.mode, 'web');
  assert.equal(result.answer, 'The current InnerScope Hearing Technologies ticker is INND.');
  assert.equal(result.citations.length, 2);
  assert.deepEqual(result.citations[0], { title: 'InnerScope Hearing Technologies (INND)', url: 'https://example.com/innd' });
});

test('a genuinely empty result set is a real mode:"web" outcome (searched, found nothing) -- distinct from "unconfigured"', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ answer: '', results: [] }), { status: 200 })) as unknown as typeof fetch,
    () => tavilyWebSearch('something with zero real-world results', 'tvly-test-key'),
  );
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.citations, []);
  assert.equal(result.error, undefined);
});

test('a non-2xx response with the top-level {error} shape surfaces the status + message in `error`, never throws', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ error: 'Unauthorized: invalid API key' }), { status: 401 })) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-bad-key'),
  );
  assert.equal(result.mode, 'error');
  assert.match(result.error ?? '', /401/);
  assert.match(result.error ?? '', /invalid API key/);
});

test('a non-2xx response with the {detail:{error}} shape is also handled', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ detail: { error: 'quota exceeded' } }), { status: 432 })) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key'),
  );
  assert.equal(result.mode, 'error');
  assert.match(result.error ?? '', /quota exceeded/);
});

test('a network failure surfaces as a bounded timeout error, never a thrown exception', async () => {
  const result = await withStubbedFetch(
    (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key'),
  );
  assert.equal(result.mode, 'error');
  assert.equal(result.error, 'web_search timeout');
});

// ── Task G-3 (2026-09-03): domain governance -- request shaping + result post-filter ──

test('a bare 2-argument call (no governance) is unaffected: no include_domains/exclude_domains key at all', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answer: '', results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key'),
  );
  assert.equal('include_domains' in seenBody, false);
  assert.equal('exclude_domains' in seenBody, false);
});

test('an explicit NO_DOMAIN_GOVERNANCE value behaves identically to omitting the parameter', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answer: '', results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal('include_domains' in seenBody, false);
  assert.equal('exclude_domains' in seenBody, false);
});

test('a configured allow/deny governance is sent as include_domains/exclude_domains on the request', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answer: '', results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key', { allow: ['good.example'], deny: ['evil.example'] }),
  );
  assert.deepEqual(seenBody.include_domains, ['good.example']);
  assert.deepEqual(seenBody.exclude_domains, ['evil.example']);
});

test('governance ALSO post-filters the response citations, independent of what Tavily itself returned', async () => {
  const result = await withStubbedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          answer: 'an answer citing both',
          results: [
            { title: 'a good source', url: 'https://good.example/a' },
            { title: 'a source Tavily returned anyway despite exclude_domains', url: 'https://evil.example/b' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key', { allow: [], deny: ['evil.example'] }),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], { title: 'a good source', url: 'https://good.example/a' });
});

test('the answer is capped at 4000 characters, same as the Azure provider', async () => {
  const longText = 'y'.repeat(5000);
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ answer: longText, results: [] }), { status: 200 })) as unknown as typeof fetch,
    () => tavilyWebSearch('anything', 'tvly-test-key'),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.answer.length, 4000);
});
