import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tavilyWebExtract, tavilyExtractConfigured } from './tavily-web-extract.js';
import { NO_DOMAIN_GOVERNANCE } from '../domain-governance.js';

// Same pattern as tavily-web-search.test.ts / tavily-web-research.test.ts: this module takes its
// API key as a plain function argument (not through loadEnv()), so it is testable like this with
// no per-process env-parse cache to work around.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('tavilyExtractConfigured() is false for an empty key, true for a non-empty one', () => {
  assert.equal(tavilyExtractConfigured(''), false);
  assert.equal(tavilyExtractConfigured('tvly-abc123'), true);
});

test('an empty API key returns a clearly-labeled unconfigured result and never calls fetch at all', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], '', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(result.mode, 'unconfigured');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.filtered, []);
  assert.equal(fetchCalled, false, 'an unconfigured provider must never make a network call');
});

test('a successful extraction hits api.tavily.com/extract with a bearer token and {urls} in the body', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const result = await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(
        JSON.stringify({ results: [{ url: 'https://example.com/a', raw_content: 'the page text', favicon: 'https://example.com/favicon.ico' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(seenUrl, 'https://api.tavily.com/extract');
  assert.equal(seenInit?.method, 'POST');
  const auth = (seenInit?.headers as Record<string, string> | undefined)?.Authorization;
  assert.equal(auth, 'Bearer tvly-test-key');
  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body.urls, ['https://example.com/a']);
  assert.equal('query' in body, false, 'query is omitted entirely when not supplied');
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.results, [{ url: 'https://example.com/a', content: 'the page text', favicon: 'https://example.com/favicon.ico' }]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.filtered, []);
});

test('an optional query reranking hint is included in the request body when supplied', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE, { query: 'the relevant part' }),
  );
  assert.equal(seenBody.query, 'the relevant part');
});

test('multiple URLs are all sent in one request', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://a.example/1', 'https://b.example/2', 'https://c.example/3'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.deepEqual(seenBody.urls, ['https://a.example/1', 'https://b.example/2', 'https://c.example/3']);
});

test('more than 20 URLs are truncated to Tavily\'s documented per-request ceiling before ever being sent', async () => {
  let seenBody: Record<string, unknown> = {};
  const urls = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(urls, 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal((seenBody.urls as string[]).length, 20);
  assert.deepEqual(seenBody.urls, urls.slice(0, 20));
});

test('failed_results are mapped into `failed`, alongside any successful `results` in the same response', async () => {
  const result = await withStubbedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          results: [{ url: 'https://good.example/a', raw_content: 'ok' }],
          failed_results: [{ url: 'https://bad.example/b', error: 'timeout fetching page' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://good.example/a', 'https://bad.example/b'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.results, [{ url: 'https://good.example/a', content: 'ok', favicon: undefined }]);
  assert.deepEqual(result.failed, [{ url: 'https://bad.example/b', error: 'timeout fetching page' }]);
});

test('content is capped at 20000 characters', async () => {
  const longText = 'z'.repeat(25_000);
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ results: [{ url: 'https://example.com/a', raw_content: longText }] }), { status: 200 })) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(result.mode, 'web');
  assert.equal(result.results[0]?.content.length, 20_000);
});

test('a non-2xx response surfaces the status + message in error, mode:"error"', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ detail: { error: 'invalid API key' } }), { status: 401 })) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-bad-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(result.mode, 'error');
  assert.match(result.error ?? '', /401/);
  assert.match(result.error ?? '', /invalid API key/);
  assert.deepEqual(result.results, []);
});

test('a network failure surfaces as a bounded timeout error, never a thrown exception', async () => {
  const result = await withStubbedFetch(
    (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.equal(result.mode, 'error');
  assert.equal(result.error, 'web_extract timeout');
});

// ── Task G-3 (2026-09-03): domain governance -- PRE-filter (never even asks Tavily) ──

test('a denied URL is dropped BEFORE the request is sent, and never appears in the request body', async () => {
  let seenBody: Record<string, unknown> = {};
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      fetchCalled = true;
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [{ url: 'https://good.example/a', raw_content: 'ok' }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () =>
      tavilyWebExtract(['https://good.example/a', 'https://evil.example/b'], 'tvly-test-key', {
        allow: [],
        deny: ['evil.example'],
      }),
  );
  assert.equal(fetchCalled, true, 'the surviving URL still goes to Tavily');
  assert.deepEqual(seenBody.urls, ['https://good.example/a'], 'the denied URL never reaches the request body');
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.filtered, [
    { url: 'https://evil.example/b', reason: 'blocked by WEB_SEARCH_DOMAIN_DENY, or not on a configured WEB_SEARCH_DOMAIN_ALLOW -- never requested from Tavily' },
  ]);
});

test('EVERY URL denied -> mode:"domain_blocked", Tavily is NEVER called at all', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://evil.example/a', 'https://evil.example/b'], 'tvly-test-key', { allow: [], deny: ['evil.example'] }),
  );
  assert.equal(fetchCalled, false, 'a fully-blocked request must never reach Tavily');
  assert.equal(result.mode, 'domain_blocked');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.filtered.length, 2);
  assert.ok(result.filtered.every((f) => f.url.includes('evil.example')));
});

test('an allowlist admits only matching URLs, dropping the rest before the request', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () =>
      tavilyWebExtract(['https://allowed.example/a', 'https://other.example/b'], 'tvly-test-key', {
        allow: ['allowed.example'],
        deny: [],
      }),
  );
  assert.deepEqual(seenBody.urls, ['https://allowed.example/a']);
});

test('DENY WINS over an overlapping allow entry, on the pre-filter', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', { allow: ['example.com'], deny: ['example.com'] }),
  );
  assert.equal(fetchCalled, false);
  assert.equal(result.mode, 'domain_blocked');
});

// ── domain governance -- POST-filter (defense in depth against e.g. a redirect) ──

test('a result whose returned URL fails governance is dropped AFTER the call too, independent of what was requested', async () => {
  const result = await withStubbedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          // Simulates a redirect: the caller asked for good.example, Tavily's response instead
          // carries evil.example as the URL it actually fetched.
          results: [{ url: 'https://evil.example/redirected', raw_content: 'redirected content' }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://good.example/a'], 'tvly-test-key', { allow: [], deny: ['evil.example'] }),
  );
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.results, []);
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0]?.url, 'https://evil.example/redirected');
  assert.match(result.filtered[0]?.reason ?? '', /redirect/);
});

test('governance-blocked URLs from the PRE-filter and POST-filter are both reported in the same `filtered` array', async () => {
  const result = await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      assert.deepEqual(body.urls, ['https://good.example/a'], 'the pre-filtered URL never reached the request');
      return new Response(JSON.stringify({ results: [{ url: 'https://evil.example/redirected', raw_content: 'x' }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () =>
      tavilyWebExtract(['https://good.example/a', 'https://denied.example/b'], 'tvly-test-key', {
        allow: [],
        deny: ['denied.example', 'evil.example'],
      }),
  );
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.results, []);
  assert.equal(result.filtered.length, 2, 'one pre-filter drop + one post-filter drop');
  assert.ok(result.filtered.some((f) => f.url === 'https://denied.example/b' && /never requested/.test(f.reason)));
  assert.ok(result.filtered.some((f) => f.url === 'https://evil.example/redirected' && /redirect/.test(f.reason)));
});

test('an unparseable returned URL in a result is DROPPED, not passed through (opposite default from citations)', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ results: [{ url: 'not a url at all', raw_content: 'x' }] }), { status: 200 })) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://example.com/a'], 'tvly-test-key', { allow: [], deny: ['evil.example'] }),
  );
  assert.equal(result.mode, 'web');
  assert.deepEqual(result.results, []);
  assert.equal(result.filtered.length, 1);
  assert.equal(result.filtered[0]?.url, 'not a url at all');
});

test('an explicit NO_DOMAIN_GOVERNANCE value behaves identically to unconfigured governance (a true no-op)', async () => {
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebExtract(['https://anything.example/a'], 'tvly-test-key', NO_DOMAIN_GOVERNANCE),
  );
  assert.deepEqual(seenBody.urls, ['https://anything.example/a']);
});
