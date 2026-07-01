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

test('probeDependencies: reports "ok" for a configured, reachable dependency', async () => {
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  let calledUrl: string | undefined;
  globalThis.fetch = (async (url: unknown) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.foundry, 'ok');
  // Regression guard: the Foundry probe must hit the cheap deployments-list metadata GET, never a
  // chat/completions or embeddings endpoint (those cost tokens on every /health/deep poll).
  assert.match(calledUrl ?? '', /\/openai\/deployments\?api-version=/);
  assert.doesNotMatch(calledUrl ?? '', /chat\/completions|embeddings/);
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
