import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tavilyWebResearch, tavilyResearchConfigured } from './tavily-web-research.js';
import { NO_DOMAIN_GOVERNANCE } from '../domain-governance.js';

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const BASE_OPTS = { maxWaitMs: 5_000, pollIntervalMs: 10, governance: NO_DOMAIN_GOVERNANCE };

test('tavilyResearchConfigured() is false for an empty key, true for a non-empty one', () => {
  assert.equal(tavilyResearchConfigured(''), false);
  assert.equal(tavilyResearchConfigured('tvly-abc123'), true);
});

test('an empty API key returns "unconfigured" and never calls fetch at all', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('anything', '', BASE_OPTS),
  );
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
  assert.equal(result.request_id, undefined);
  assert.equal(fetchCalled, false);
});

test('neither query nor requestId supplied -> a clear error, never a network call', async () => {
  let fetchCalled = false;
  const result = await withStubbedFetch(
    (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch,
    () => tavilyWebResearch(undefined, 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /requires either/);
  assert.equal(fetchCalled, false);
});

test('creates a task via POST /research with {input, model:"mini"} -- model is never caller-controlled', async () => {
  const calls: { url: string; method?: string; body?: Record<string, unknown> }[] = [];
  await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (calls.length === 1) return new Response(JSON.stringify({ request_id: 'req-1', status: 'pending' }), { status: 201 });
      return new Response(JSON.stringify({ request_id: 'req-1', status: 'completed', content: 'the report', sources: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('what happened in AI this week', 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(calls[0]!.url, 'https://api.tavily.com/research');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.body?.input, 'what happened in AI this week');
  assert.equal(calls[0]!.body?.model, 'mini');
  assert.equal('include_domains' in (calls[0]!.body ?? {}), false, 'no domain params when governance is empty');
});

test('domain governance is sent on CREATE as include_domains/exclude_domains', async () => {
  const calls: Record<string, unknown>[] = [];
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) return new Response(JSON.stringify({ request_id: 'req-1', status: 'pending' }), { status: 201 });
      return new Response(JSON.stringify({ status: 'completed', content: 'x', sources: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () =>
      tavilyWebResearch('q', 'tvly-test-key', {
        ...BASE_OPTS,
        governance: { allow: ['good.example'], deny: ['evil.example'] },
      }),
  );
  assert.deepEqual(calls[0]!.include_domains, ['good.example']);
  assert.deepEqual(calls[0]!.exclude_domains, ['evil.example']);
});

test('polls GET /research/{request_id} with a bearer token until status:"completed", returning content+sources', async () => {
  const urls: string[] = [];
  const result = await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      urls.push(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      assert.equal(auth, 'Bearer tvly-test-key');
      if (urls.length === 1) {
        assert.equal(init?.method, 'POST', 'create is an explicit POST');
        return new Response(JSON.stringify({ request_id: 'req-42', status: 'pending' }), { status: 201 });
      }
      assert.notEqual(init?.method, 'POST', 'polling is a GET, not a POST');
      if (urls.length === 2) return new Response(JSON.stringify({ request_id: 'req-42', status: 'in_progress' }), { status: 202 });
      return new Response(
        JSON.stringify({
          request_id: 'req-42',
          status: 'completed',
          content: 'Research Report: ...',
          sources: [{ title: 'A Source', url: 'https://example.com/a' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', { maxWaitMs: 5_000, pollIntervalMs: 1, governance: NO_DOMAIN_GOVERNANCE }),
  );
  assert.equal(urls[0], 'https://api.tavily.com/research');
  assert.equal(urls[1], 'https://api.tavily.com/research/req-42');
  assert.equal(urls[2], 'https://api.tavily.com/research/req-42');
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'Research Report: ...');
  assert.deepEqual(result.citations, [{ title: 'A Source', url: 'https://example.com/a' }]);
  assert.equal(result.request_id, 'req-42');
});

test('resuming via requestId skips the create step entirely (no POST call)', async () => {
  const calls: { url: string; method?: string }[] = [];
  const result = await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ status: 'completed', content: 'done', sources: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => tavilyWebResearch(undefined, 'tvly-test-key', { ...BASE_OPTS, requestId: 'existing-req' }),
  );
  assert.equal(calls.length, 1, 'resuming makes exactly one poll call, never a create call');
  assert.equal(calls[0]!.url, 'https://api.tavily.com/research/existing-req');
  assert.notEqual(calls[0]!.method, 'POST');
  assert.equal(result.status, 'completed');
  assert.equal(result.request_id, 'existing-req');
});

test('the returned sources are post-filtered by domain governance, independent of what Tavily returned', async () => {
  const result = await withStubbedFetch(
    (async (url: string) =>
      url.includes('/research/') && !url.endsWith('/research')
        ? new Response(
            JSON.stringify({
              status: 'completed',
              content: 'report',
              sources: [
                { title: 'good', url: 'https://good.example/a' },
                { title: 'bad', url: 'https://evil.example/b' },
              ],
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ request_id: 'req-9', status: 'pending' }), { status: 201 })) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', { ...BASE_OPTS, governance: { allow: [], deny: ['evil.example'] } }),
  );
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], { title: 'good', url: 'https://good.example/a' });
});

test('status:"failed" is reported as failed, with the request_id, never as completed with an empty answer', async () => {
  const result = await withStubbedFetch(
    (async (url: string) =>
      url.includes('/research/') && !url.endsWith('/research')
        ? new Response(JSON.stringify({ status: 'failed' }), { status: 200 })
        : new Response(JSON.stringify({ request_id: 'req-f', status: 'pending' }), { status: 201 })) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.request_id, 'req-f');
  assert.ok(result.error);
});

test('BOUNDED: still "pending"/"in_progress" when the wait budget elapses returns status:"pending" with request_id, never blocks past the budget', async () => {
  let polls = 0;
  const start = Date.now();
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.endsWith('/research')) return new Response(JSON.stringify({ request_id: 'req-slow', status: 'pending' }), { status: 201 });
      polls++;
      return new Response(JSON.stringify({ status: 'in_progress' }), { status: 202 });
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', { maxWaitMs: 30, pollIntervalMs: 10, governance: NO_DOMAIN_GOVERNANCE }),
  );
  const elapsed = Date.now() - start;
  assert.equal(result.status, 'pending');
  assert.equal(result.request_id, 'req-slow');
  assert.equal(result.answer, '');
  assert.deepEqual(result.citations, []);
  assert.ok(polls >= 1, 'at least one poll happened');
  assert.ok(elapsed < 2_000, `must not block far past the bounded budget (elapsed=${elapsed}ms)`);
});

test('a network failure while creating the task surfaces as a bounded error, never throws', async () => {
  const result = await withStubbedFetch(
    (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /timeout/);
  assert.equal(result.request_id, undefined);
});

test('a network failure while POLLING an existing task surfaces as a bounded error carrying the request_id', async () => {
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.endsWith('/research')) return new Response(JSON.stringify({ request_id: 'req-net', status: 'pending' }), { status: 201 });
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.request_id, 'req-net');
  assert.match(result.error ?? '', /timeout/);
});

test('a non-2xx (non-202) response on create surfaces the status+message in error', async () => {
  const result = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ detail: { error: 'invalid API key' } }), { status: 401 })) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-bad-key', BASE_OPTS),
  );
  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /401/);
  assert.match(result.error ?? '', /invalid API key/);
});

test('the answer is capped at 8000 characters', async () => {
  const longText = 'z'.repeat(9_000);
  const result = await withStubbedFetch(
    (async (url: string) =>
      url.endsWith('/research')
        ? new Response(JSON.stringify({ request_id: 'req-long', status: 'pending' }), { status: 201 })
        : new Response(JSON.stringify({ status: 'completed', content: longText, sources: [] }), { status: 200 })) as unknown as typeof fetch,
    () => tavilyWebResearch('q', 'tvly-test-key', BASE_OPTS),
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.answer.length, 8_000);
});
