import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.N8N_API_KEY ||= 'test-n8n-key';
process.env.N8N_BASE_URL ||= 'https://cs-n8n.otchealthmart.com';

const { n8nGet, N8nApiError } = await import('./api-client.js');
const { __resetN8nReachabilityCache } = await import('./reachability.js');

function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('n8nGet: when n8n is unreachable (the live 502 shape), the call is refused BEFORE any real API request is attempted', async () => {
  __resetN8nReachabilityCache();
  const calls: string[] = [];
  await assert.rejects(
    () =>
      withFetch(
        (async (u: string | URL | Request) => {
          calls.push(String(u));
          return new Response('Bad Gateway', { status: 502 });
        }) as unknown as typeof fetch,
        () => n8nGet('/workflows'),
      ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_degraded');
      assert.equal(err.status, 503);
      return true;
    },
  );
  // Only the reachability probe ran; the real /api/v1/workflows request was never attempted.
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://cs-n8n.otchealthmart.com/healthz');
});

test('n8nGet: when n8n is reachable, the call proceeds to the real API path with the real auth header', async () => {
  __resetN8nReachabilityCache();
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const result = await withFetch(
    (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.endsWith('/healthz')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: 'wf_1' }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => n8nGet<{ data: unknown[] }>('/workflows'),
  );
  assert.deepEqual(result, { data: [{ id: 'wf_1' }] });
  assert.equal(calls.length, 2, 'the healthz probe, then the real request');
  assert.equal(calls[0].url, 'https://cs-n8n.otchealthmart.com/healthz');
  assert.equal(calls[1].url, 'https://cs-n8n.otchealthmart.com/api/v1/workflows');
  assert.equal(calls[1].headers['x-n8n-api-key'], 'test-n8n-key');
});

test('n8nGet: optional response ceiling accepts a streamed body exactly at the byte limit', async () => {
  __resetN8nReachabilityCache();
  const expected = JSON.stringify({ data: [{ id: 'wf_1' }] });
  const encoded = new TextEncoder().encode(expected);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 5));
      controller.enqueue(encoded.slice(5));
      controller.close();
    },
  });
  const result = await withFetch(
    (async (u: string | URL | Request) => String(u).endsWith('/healthz')
      ? new Response('ok')
      : new Response(body, { headers: { 'content-length': '1' } })) as unknown as typeof fetch,
    () => n8nGet<{ data: Array<{ id: string }> }>('/workflows', { maxResponseBytes: encoded.byteLength }),
  );
  assert.deepEqual(result, { data: [{ id: 'wf_1' }] });
});

test('n8nGet: optional response ceiling cancels the stream on overflow despite a small Content-Length', async () => {
  __resetN8nReachabilityCache();
  const sensitive = 'UPSTREAM_SECRET_SENTINEL';
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sensitive));
      controller.enqueue(new TextEncoder().encode('more bytes beyond the cap'));
    },
    cancel() { cancelled = true; },
  });

  await assert.rejects(
    () => withFetch(
      (async (u: string | URL | Request) => String(u).endsWith('/healthz')
        ? new Response('ok')
        : new Response(body, { headers: { 'content-length': '1' } })) as unknown as typeof fetch,
      () => n8nGet('/workflows', { maxResponseBytes: 8 }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_response_too_large');
      assert.equal(err.upstream, undefined);
      assert.equal(err.message.includes(sensitive), false);
      return true;
    },
  );
  assert.equal(cancelled, true, 'the overflowing response reader must be cancelled');
});

test('n8nGet: bounded non-success responses omit upstream text and body', async () => {
  __resetN8nReachabilityCache();
  const sensitive = 'UPSTREAM_SECRET_SENTINEL';
  await assert.rejects(
    () => withFetch(
      (async (u: string | URL | Request) => String(u).endsWith('/healthz')
        ? new Response('ok')
        : new Response(JSON.stringify({ error: sensitive }), { status: 500 } as ResponseInit)) as unknown as typeof fetch,
      () => n8nGet('/workflows', { maxResponseBytes: 1024 }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_upstream_error');
      assert.equal(err.upstream, undefined);
      assert.equal(err.message.includes(sensitive), false);
      return true;
    },
  );
});

test('n8nGet: bounded invalid JSON is reported without preserving response content', async () => {
  __resetN8nReachabilityCache();
  const sensitive = 'UPSTREAM_SECRET_SENTINEL';
  await assert.rejects(
    () => withFetch(
      (async (u: string | URL | Request) => String(u).endsWith('/healthz')
        ? new Response('ok')
        : new Response(sensitive)) as unknown as typeof fetch,
      () => n8nGet('/workflows', { maxResponseBytes: 1024 }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_invalid_json');
      assert.equal(err.upstream, undefined);
      assert.equal(err.message.includes(sensitive), false);
      return true;
    },
  );
});

test('n8nGet: bounded stream read failures are sanitized', async () => {
  __resetN8nReachabilityCache();
  const sensitive = 'UPSTREAM_SECRET_SENTINEL';
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error(sensitive)); },
  });
  await assert.rejects(
    () => withFetch(
      (async (u: string | URL | Request) => String(u).endsWith('/healthz')
        ? new Response('ok')
        : new Response(body)) as unknown as typeof fetch,
      () => n8nGet('/workflows', { maxResponseBytes: 1024 }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_response_read_failed');
      assert.equal(err.upstream, undefined);
      assert.equal(err.message.includes(sensitive), false);
      return true;
    },
  );
});

test('n8nGet: bounded response ceilings must be positive safe integers', async () => {
  __resetN8nReachabilityCache();
  const calls: string[] = [];
  await assert.rejects(
    () => withFetch(
      (async (u: string | URL | Request) => { calls.push(String(u)); return new Response('ok'); }) as unknown as typeof fetch,
      () => n8nGet('/workflows', { maxResponseBytes: 0 }),
    ),
    (err: unknown) => {
      assert.ok(err instanceof N8nApiError);
      assert.equal(err.code, 'n8n_invalid_response_limit');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});
