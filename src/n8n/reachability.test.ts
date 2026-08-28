import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.N8N_BASE_URL ||= 'https://cs-n8n.otchealthmart.com';

const { n8nReachable, __resetN8nReachabilityCache, N8N_DEGRADED } = await import('./reachability.js');

function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('n8nReachable: a real 2xx from /healthz resolves true', async () => {
  __resetN8nReachabilityCache();
  const calls: string[] = [];
  const ok = await withFetch(
    (async (u: string | URL | Request) => {
      calls.push(String(u));
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch,
    () => n8nReachable(),
  );
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://cs-n8n.otchealthmart.com/healthz');
});

test('n8nReachable: a non-ok HTTP response (the exact live 502 shape) resolves false, not true', async () => {
  // THE CASE THIS GATE EXISTS FOR: cs-n8n.otchealthmart.com answers a FAST 502 today (the reverse
  // proxy is up, n8n itself is not). A gate that only caught a thrown/rejected fetch would let this
  // exact response straight through and defeat the whole point on day one.
  __resetN8nReachabilityCache();
  const ok = await withFetch(
    (async () => new Response('Bad Gateway', { status: 502 })) as unknown as typeof fetch,
    () => n8nReachable(),
  );
  assert.equal(ok, false);
});

test('n8nReachable: a network rejection (DNS failure, connection refused, timeout) resolves false, never throws', async () => {
  __resetN8nReachabilityCache();
  const ok = await withFetch(
    (async () => {
      throw new Error('getaddrinfo ENOTFOUND cs-n8n.otchealthmart.com');
    }) as unknown as typeof fetch,
    () => n8nReachable(),
  );
  assert.equal(ok, false);
});

test('n8nReachable: caches a NEGATIVE verdict, so a burst of calls does not re-probe every time', async () => {
  __resetN8nReachabilityCache();
  let fetchCount = 0;
  const run = () =>
    withFetch(
      (async () => {
        fetchCount++;
        return new Response('', { status: 502 });
      }) as unknown as typeof fetch,
      async () => {
        const a = await n8nReachable();
        const b = await n8nReachable();
        const c = await n8nReachable();
        return [a, b, c];
      },
    );
  const results = await run();
  assert.deepEqual(results, [false, false, false]);
  assert.equal(fetchCount, 1, 'only the first call should actually probe; the rest must reuse the cached verdict');
});

test('n8nReachable: caches a POSITIVE verdict too, not only a negative one', async () => {
  __resetN8nReachabilityCache();
  let fetchCount = 0;
  const results = await withFetch(
    (async () => {
      fetchCount++;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch,
    async () => [await n8nReachable(), await n8nReachable()],
  );
  assert.deepEqual(results, [true, true]);
  assert.equal(fetchCount, 1);
});

test('n8nReachable: recovery auto-detects once a fresh probe (post-reset) sees a real 2xx', async () => {
  // __resetN8nReachabilityCache is the deterministic stand-in for "the TTL window has elapsed" --
  // this proves the SAME mechanism the real 60s TTL uses: a fresh probe reflects current reality
  // with zero code change and zero redeploy, the entire point of a reachability gate over an env
  // flag a human would have to flip back.
  __resetN8nReachabilityCache();
  const down = await withFetch(
    (async () => new Response('', { status: 502 })) as unknown as typeof fetch,
    () => n8nReachable(),
  );
  assert.equal(down, false);

  __resetN8nReachabilityCache();
  const up = await withFetch(
    (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    () => n8nReachable(),
  );
  assert.equal(up, true, 'a fresh probe after the cache resets must reflect the NEW live state, not the stale cached one');
});

test('N8N_DEGRADED: the shared shape has the fields every N8n*Error constructor needs, and names the real recovery lane', () => {
  assert.equal(N8N_DEGRADED.code, 'n8n_degraded');
  assert.equal(N8N_DEGRADED.status, 503);
  assert.match(N8N_DEGRADED.message, /cs-n8n\.otchealthmart\.com/);
  assert.match(N8N_DEGRADED.nextStep, /aws-n8n-recovery/);
  // No em or en dash (published-string rule) -- this text can surface in a tool response.
  assert.equal(/[–—]/.test(N8N_DEGRADED.message), false);
  assert.equal(/[–—]/.test(N8N_DEGRADED.nextStep), false);
});
