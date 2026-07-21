import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set required env vars before importing the module (loadEnv runs at import time).
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) {
    process.env[k] ??= v;
  }
});

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  // Clear every dependency's config to a known-unset baseline before each test, so tests do not
  // leak configuration into one another (loadEnv() caches its parsed result at first import, but
  // deep-health.ts calls loadEnv() fresh inside each probe on every invocation, so mutating
  // process.env here is picked up per-test as long as it happens before the probe call).
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
  delete process.env.AZURE_SEARCH_ENDPOINT;
  delete process.env.AZURE_SEARCH_QUERY_KEY;
  delete process.env.FOUNDRY_OPENAI_ENDPOINT;
  delete process.env.FOUNDRY_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['COSMOS_ENDPOINT', 'COSMOS_KEY', 'AZURE_SEARCH_ENDPOINT', 'AZURE_SEARCH_QUERY_KEY', 'FOUNDRY_OPENAI_ENDPOINT', 'FOUNDRY_KEY']) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('probeDependencies: reports "unconfigured" for every dependency with no env set', async () => {
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.deepEqual(result, { cosmos: 'unconfigured', search: 'unconfigured', foundry: 'unconfigured' });
});

test('probeDependencies: reports "down" for a configured-but-unreachable dependency (network error)', async () => {
  process.env.COSMOS_ENDPOINT = 'https://fake-cosmos.example.com';
  process.env.COSMOS_KEY = Buffer.from('fake-key-material').toString('base64');
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.cosmos, 'down');
  // The other two stay unconfigured (their env is still unset) even though fetch would also throw
  // for them if invoked, proving probes short-circuit on isConfigured() before ever calling fetch.
  assert.equal(result.search, 'unconfigured');
  assert.equal(result.foundry, 'unconfigured');
});

test('probeDependencies: reports "down" for a configured dependency that returns a non-2xx status', async () => {
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake-search.example.com';
  process.env.AZURE_SEARCH_QUERY_KEY = 'fake-query-key';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.search, 'down');
});

test('probeDependencies: Search probe targets a zero-result document search, not the index metadata GET', async () => {
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake-search.example.com';
  process.env.AZURE_SEARCH_QUERY_KEY = 'fake-query-key';
  let calledUrl: string | undefined;
  let calledMethod: string | undefined;
  let calledBody: string | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method;
    calledBody = init?.body as string | undefined;
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.search, 'ok');
  // 2026-07-21: GET /indexes/{name} (index metadata/schema) is an index-MANAGEMENT operation that a
  // query key cannot perform (Azure returns 403 regardless of key validity or service health), so
  // this probe always reported 'down' until fixed. It now POSTs a top:0 document search, the
  // operation a query key is actually authorized for, on the same index.
  assert.match(calledUrl ?? '', /\/indexes\/memory-exec\/docs\/search\?api-version=/);
  assert.equal(calledMethod, 'POST');
  assert.equal(calledBody, JSON.stringify({ search: '*', top: 0 }));
});

test('probeDependencies: reports "ok" for a configured, reachable dependency', async () => {
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  let calledUrl: string | undefined;
  let calledBody: string | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = String(url);
    calledBody = init?.body as string | undefined;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.foundry, 'ok');
  // 2026-07-21: /openai/deployments (list-all) 404s on this fleet's actual Foundry resource shape
  // regardless of API version (confirmed live against 4 distinct versions), so the probe now targets
  // a real deployment's embeddings endpoint with a deliberately empty input array instead. This
  // regression guard now asserts the CORRECTED target, replacing an earlier guard that asserted the
  // broken list-all endpoint and explicitly forbade this one.
  assert.match(calledUrl ?? '', /\/openai\/deployments\/text-embedding-3-large\/embeddings\?api-version=/);
  assert.equal(calledBody, JSON.stringify({ input: [] }));
});

test('probeDependencies: reports "ok" for Foundry on a 400 (Azure\'s fast empty-input validation reject), not just a 2xx', async () => {
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid 'input': input cannot be an empty array." } }), { status: 400 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  // A 400 here means the request was authenticated and reached a real deployment before Azure
  // rejected the (deliberately) empty input; that is the reachability signal this probe wants. A
  // sibling test below confirms a genuinely UNAUTHENTICATED call (a bad key) gets 401, not 400, so
  // this 400-as-ok mapping cannot be satisfied by an unreachable or misconfigured dependency.
  assert.equal(result.foundry, 'ok');
});

test('probeDependencies: reports "down" for Foundry on a 401 (bad key), not confused with the 400 reachability signal', async () => {
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'wrong-key';
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: '401', message: 'Access denied due to invalid subscription key' } }), { status: 401 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.foundry, 'down');
});

test('probeDependencies: all three "ok" together when every dependency is configured and reachable', async () => {
  process.env.COSMOS_ENDPOINT = 'https://fake-cosmos.example.com';
  process.env.COSMOS_KEY = Buffer.from('fake-key-material').toString('base64');
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake-search.example.com';
  process.env.AZURE_SEARCH_QUERY_KEY = 'fake-query-key';
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.deepEqual(result, { cosmos: 'ok', search: 'ok', foundry: 'ok' });
});
