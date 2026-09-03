import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so every env var this file's tests depend on
// (TAVILY_API_KEY, WEB_SEARCH_DOMAIN_ALLOW/_DENY) must be settled BEFORE that first call, matching
// web-search-provider-tavily.test.ts's discipline. One fixed governance config for the WHOLE file
// (domain-governance.test.ts and tavily-web-research.test.ts already cover governance parsing and
// allow/deny precedence exhaustively as a pure function of an explicit `gov` argument -- this file's
// job is only to prove runWebResearch() actually WIRES env into that already-proven logic).
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.TAVILY_API_KEY = 'tvly-test-key';
process.env.WEB_SEARCH_DOMAIN_ALLOW = 'good.example';
process.env.WEB_SEARCH_DOMAIN_DENY = 'evil.example';

const { runWebResearch } = await import('./web-research.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('runWebResearch() reads TAVILY_API_KEY from env and sends it as a bearer token', async () => {
  let seenAuth = '';
  await withStubbedFetch(
    (async (_url: string, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      return new Response(JSON.stringify({ request_id: 'r1', status: 'pending' }), { status: 201 });
    }) as unknown as typeof fetch,
    () => runWebResearch({ query: 'anything', max_wait_seconds: 0, poll_interval_seconds: 1 }),
  );
  assert.equal(seenAuth, 'Bearer tvly-test-key');
});

test('runWebResearch() reads WEB_SEARCH_DOMAIN_ALLOW/_DENY from env and sends them on task creation', async () => {
  // Branches on the URL (create vs. poll, the SAME pattern tavily-web-research.test.ts's own
  // "domain governance is sent on CREATE" test uses) so the poll leg's body-less GET is never fed
  // through JSON.parse -- only the create POST actually carries a body worth inspecting.
  let seenBody: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/research')) {
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ request_id: 'r-gov', status: 'pending' }), { status: 201 });
      }
      return new Response(JSON.stringify({ status: 'completed', content: 'x', sources: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebResearch({ query: 'anything', max_wait_seconds: 0, poll_interval_seconds: 1 }),
  );
  assert.deepEqual(seenBody.include_domains, ['good.example']);
  assert.deepEqual(seenBody.exclude_domains, ['evil.example']);
});

test('runWebResearch() converts max_wait_seconds/poll_interval_seconds from SECONDS to milliseconds: max_wait_seconds:0 polls exactly once before returning "pending"', async () => {
  let pollCount = 0;
  const result = await withStubbedFetch(
    (async (url: string) => {
      if (url.endsWith('/research')) return new Response(JSON.stringify({ request_id: 'r-zero', status: 'pending' }), { status: 201 });
      pollCount++;
      return new Response(JSON.stringify({ status: 'in_progress' }), { status: 202 });
    }) as unknown as typeof fetch,
    () => runWebResearch({ query: 'anything', max_wait_seconds: 0, poll_interval_seconds: 1 }),
  );
  assert.equal(result.status, 'pending');
  assert.equal(result.request_id, 'r-zero');
  assert.equal(pollCount, 1, 'max_wait_seconds:0 must convert to maxWaitMs:0 -- exactly one poll, no further looping');
});

test('runWebResearch() defaults max_wait_seconds/poll_interval_seconds when omitted -- a first-poll completion returns immediately regardless', async () => {
  const start = Date.now();
  const result = await withStubbedFetch(
    (async (url: string) =>
      url.endsWith('/research')
        ? new Response(JSON.stringify({ request_id: 'r-default', status: 'pending' }), { status: 201 })
        : new Response(JSON.stringify({ status: 'completed', content: 'done', sources: [] }), { status: 200 })) as unknown as typeof fetch,
    () => runWebResearch({ query: 'anything' }),
  );
  const elapsed = Date.now() - start;
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'done');
  assert.ok(elapsed < 2_000, `a first-poll completion must return immediately, not wait out the default budget; got ${elapsed}ms`);
});

test('runWebResearch() passes request_id straight through to resume a task, making no create call at all', async () => {
  const calls: string[] = [];
  const result = await withStubbedFetch(
    (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ status: 'completed', content: 'resumed', sources: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => runWebResearch({ request_id: 'existing-task', max_wait_seconds: 0, poll_interval_seconds: 1 }),
  );
  assert.equal(calls.length, 1, 'resuming makes exactly one poll call, no create call');
  assert.equal(calls[0], 'https://api.tavily.com/research/existing-task');
  assert.equal(result.status, 'completed');
  assert.equal(result.request_id, 'existing-task');
});

test('runWebResearch() surfaces the sources from a completed task, already domain-governance-filtered', async () => {
  const result = await withStubbedFetch(
    (async (url: string) =>
      url.endsWith('/research')
        ? new Response(JSON.stringify({ request_id: 'r-src', status: 'pending' }), { status: 201 })
        : new Response(
            JSON.stringify({
              status: 'completed',
              content: 'report',
              sources: [
                { title: 'good', url: 'https://good.example/a' },
                { title: 'bad', url: 'https://evil.example/b' },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
    () => runWebResearch({ query: 'anything' }),
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.citations.length, 1, 'the env-configured deny list must already be applied by the time runWebResearch returns');
  assert.deepEqual(result.citations[0], { title: 'good', url: 'https://good.example/a' });
});
