import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchWithBudget } from './fetch-budget.js';

// Pure, no real network: every case stubs globalThis.fetch directly. (This repo's ESM build does
// not allow node:test's mock.method() to override another module's live named export, but
// globalThis.fetch is a genuine global, not a module export, so a direct reassignment works fine.
// See src/memory/hot-cache.test.ts for the module-export limitation this sidesteps.)

async function withStubbedFetch<T>(
  stub: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('fetchWithBudget: aborts at the timeout when the upstream never responds', async () => {
  // A REAL local HTTP server that accepts the connection but never writes a response, so this
  // exercises fetchWithBudget's actual AbortSignal.timeout wiring against Node's real fetch()
  // rather than hand-simulating abort semantics in a stub (which fights node:test's own
  // cancellation machinery and poisons later tests in the same file).
  const server = http.createServer(() => {
    /* never respond */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => fetchWithBudget(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 100, retries: 0 }),
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3000, `should abort near the 100ms budget, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('fetchWithBudget: retries exactly once on HTTP 429, then returns the retry response', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'retry-after': '0' }, // 0s so the test does not actually wait
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/rate-limited', {}, { retries: 1 });
      assert.equal(res.status, 200);
      assert.equal(callCount, 2, 'should call fetch exactly twice: the original attempt + one retry');
    },
  );
});

test('fetchWithBudget: retries exactly once on HTTP 503, then returns the retry response', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('service unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/flaky', {}, { retries: 1 });
      assert.equal(res.status, 200);
      assert.equal(callCount, 2);
    },
  );
});

test('fetchWithBudget: a SECOND consecutive 429 is returned as-is, not retried a third time (retries bound is honored)', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'still rate limited' }), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/always-429', {}, { retries: 1 });
      assert.equal(res.status, 429, 'the final (still-429) response must be returned, not thrown');
      assert.equal(callCount, 2, 'exactly 1 original attempt + 1 retry, never a third call');
    },
  );
});

test('fetchWithBudget: a non-retryable 4xx (e.g. 404) is returned immediately with no retry', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/missing', {}, { retries: 1 });
      assert.equal(res.status, 404);
      assert.equal(callCount, 1, 'a plain 404 must never trigger the retry path');
    },
  );
});

test('fetchWithBudget: a 2xx success on the first attempt never retries', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/ok', {}, { retries: 1 });
      assert.equal(res.status, 200);
      assert.equal(callCount, 1);
    },
  );
});

test('fetchWithBudget: retries once on a thrown network error, then succeeds', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      if (callCount === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/transient-error', {}, { retries: 1 });
      assert.equal(res.status, 200);
      assert.equal(callCount, 2);
    },
  );
});

test('fetchWithBudget: a persistent network error after exhausting retries is thrown to the caller', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      throw new TypeError('fetch failed');
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        () => fetchWithBudget('https://example.invalid/always-fails', {}, { retries: 1 }),
        /fetch failed/,
      );
      assert.equal(callCount, 2, 'should have attempted exactly the original call + one retry');
    },
  );
});

test('fetchWithBudget: retries=0 means no retry at all, even on a 429', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    }) as typeof fetch,
    async () => {
      const res = await fetchWithBudget('https://example.invalid/no-retry-budget', {}, { retries: 0 });
      assert.equal(res.status, 429);
      assert.equal(callCount, 1);
    },
  );
});
