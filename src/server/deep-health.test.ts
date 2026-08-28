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

// 2026-08-28: extended alongside deep-health.ts's postgres/opensearch/openai probes (the
// AWS-native counterparts added when env.ts's SEARCH_BACKEND/EMBEDDINGS_PROVIDER/STATE_BACKEND
// defaults flipped away from the permanently-dead Azure family -- see that file's DeepHealthDeps
// doc comment). Every var each probe's own "am I configured" check reads must be cleared here, or
// a value left over from an EARLIER test in this file leaks into one that expects 'unconfigured'.
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are explicitly included: this sandbox (and CI, which
// hydrates the same way for SSM-backed secret reads) always has them set ambiently, so a test that
// wants to prove "opensearch is unconfigured" or "opensearch is down because no credentials
// resolve" must clear them itself rather than relying on their absence.
const CLEARED_KEYS = [
  'COSMOS_ENDPOINT',
  'COSMOS_KEY',
  'AZURE_SEARCH_ENDPOINT',
  'AZURE_SEARCH_QUERY_KEY',
  'FOUNDRY_OPENAI_ENDPOINT',
  'FOUNDRY_KEY',
  'PG_HOST',
  'PG_PORT',
  'PG_DATABASE',
  'PG_USER',
  'PG_PASSWORD',
  'PG_SSL_VERIFY',
  'OPENSEARCH_ENDPOINT',
  'OPENSEARCH_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'OPENAI_API_KEY',
] as const;

beforeEach(() => {
  // Clear every dependency's config to a known-unset baseline before each test, so tests do not
  // leak configuration into one another (loadEnv() caches its parsed result at first import, but
  // deep-health.ts reads process.env directly inside each probe on every invocation -- see that
  // module's own header comment on why -- so mutating process.env here is picked up per-test as
  // long as it happens before the probe call).
  for (const key of CLEARED_KEYS) delete process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of CLEARED_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('probeDependencies: reports "unconfigured" for every dependency with no env set', async () => {
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.deepEqual(result, {
    cosmos: 'unconfigured',
    search: 'unconfigured',
    foundry: 'unconfigured',
    postgres: 'unconfigured',
    opensearch: 'unconfigured',
    openai: 'unconfigured',
    postgres_tls_verify: null,
  });
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

test('probeDependencies: all three AZURE dependencies report "ok" together when configured and reachable (the AWS-native probes stay "unconfigured" here -- this test deliberately does not set their env, see the dedicated all-six test below)', async () => {
  process.env.COSMOS_ENDPOINT = 'https://fake-cosmos.example.com';
  process.env.COSMOS_KEY = Buffer.from('fake-key-material').toString('base64');
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake-search.example.com';
  process.env.AZURE_SEARCH_QUERY_KEY = 'fake-query-key';
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.deepEqual(result, {
    cosmos: 'ok',
    search: 'ok',
    foundry: 'ok',
    postgres: 'unconfigured',
    opensearch: 'unconfigured',
    openai: 'unconfigured',
    postgres_tls_verify: null,
  });
});

// ---------------------------------------------------------------------------------------------
// AWS-native probes (postgres, opensearch, openai), added 2026-08-28.
// ---------------------------------------------------------------------------------------------

// Requires: local `postgres` role/password `postgres` reachable at 127.0.0.1:5432, database
// `agentstate_test` -- the identical fixture agentstate/queue-postgres.test.ts already depends on
// in this same CI environment (see that file's own header for the provisioning note). Deliberately
// a REAL connection, not a fetch mock: probePostgres() uses node-postgres's raw TCP client, not
// fetch, and the whole point of these two tests is proving PG_SSL_VERIFY actually changes what a
// live TLS handshake does -- a mocked transport could not demonstrate that.
test('probePostgres (via probeDependencies): reports "down" with tls_verify=true against a real but UNTRUSTED (self-signed) server -- proves verification is genuinely attempted, not a dead flag', async () => {
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = '5432';
  process.env.PG_DATABASE = 'agentstate_test';
  process.env.PG_USER = 'postgres';
  process.env.PG_PASSWORD = 'postgres';
  // PG_SSL_VERIFY left UNSET: probePostgres() computes rejectUnauthorized as `!== 'false'`, so an
  // unset value defaults to true, matching env.ts's own PG_SSL_VERIFY schema default (2026-08-28,
  // see pg-tls-trust.test.ts for the static half of this proof). This sandbox/CI Postgres presents
  // a self-signed cert (Debian/Ubuntu's postgresql-common default, not an Amazon RDS CA), which
  // Node has no reason to trust, so a genuinely-verifying connection must fail here -- if this
  // reported 'ok' instead, rejectUnauthorized would not really be wired to the connection.
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.postgres, 'down');
  assert.equal(result.postgres_tls_verify, true);
});

test('probePostgres (via probeDependencies): reports "ok" with tls_verify=false against the SAME untrusted server once verification is explicitly disabled', async () => {
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = '5432';
  process.env.PG_DATABASE = 'agentstate_test';
  process.env.PG_USER = 'postgres';
  process.env.PG_PASSWORD = 'postgres';
  process.env.PG_SSL_VERIFY = 'false';
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.postgres, 'ok');
  assert.equal(result.postgres_tls_verify, false);
});

test('probePostgres (via probeDependencies): reports "down" (not "unconfigured") for a real host with the wrong port -- unconfigured means "no PG_HOST", not "unreachable"', async () => {
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = '1'; // nothing listens on port 1
  process.env.PG_DATABASE = 'agentstate_test';
  process.env.PG_USER = 'postgres';
  process.env.PG_PASSWORD = 'postgres';
  process.env.PG_SSL_VERIFY = 'false';
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.postgres, 'down');
  // Verification was still attempted-and-recorded even though the connection never got far enough
  // to negotiate TLS -- tlsVerify reflects the CONFIGURED intent, not whether a handshake happened.
  assert.equal(result.postgres_tls_verify, false);
});

test('probeOpensearch (via probeDependencies): reports "down" (not "unconfigured") when OPENSEARCH_ENDPOINT is set but no AWS credentials resolve', async () => {
  process.env.OPENSEARCH_ENDPOINT = 'search-fake-domain.us-east-1.es.amazonaws.com';
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / the ECS container-credentials vars are all cleared
  // by beforeEach, so resolveAwsCredentials() returns null here -- proving the probe treats
  // "endpoint configured but no way to sign a request" as a real failure, not a silent no-op.
  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.opensearch, 'down');
});

test('probeOpensearch (via probeDependencies): reports "down" for a configured, credentialed domain that returns a non-2xx status', async () => {
  process.env.OPENSEARCH_ENDPOINT = 'search-fake-domain.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  globalThis.fetch = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.opensearch, 'down');
});

test('probeOpensearch (via probeDependencies): reports "ok" and signs a GET on the domain root, needing no index to exist', async () => {
  process.env.OPENSEARCH_ENDPOINT = 'search-fake-domain.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  let calledUrl: string | undefined;
  let calledMethod: string | undefined;
  let sawAuthHeader = false;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sawAuthHeader = typeof headers.Authorization === 'string' && headers.Authorization.startsWith('AWS4-HMAC-SHA256');
    return new Response(JSON.stringify({ cluster_name: 'fake' }), { status: 200 });
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.opensearch, 'ok');
  assert.equal(calledUrl, 'https://search-fake-domain.us-east-1.es.amazonaws.com/');
  assert.equal(calledMethod, 'GET');
  assert.ok(sawAuthHeader, 'expected a SigV4 Authorization header on the OpenSearch probe request');
});

test('probeOpenai (via probeDependencies): reports "down" for a configured-but-unreachable dependency (network error)', async () => {
  process.env.OPENAI_API_KEY = 'sk-fake-openai-key';
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.openai, 'down');
});

test('probeOpenai (via probeDependencies): reports "ok" and sends a bare Bearer-authenticated models list, never a billed chat/embedding call', async () => {
  process.env.OPENAI_API_KEY = 'sk-fake-openai-key';
  let calledUrl: string | undefined;
  let calledMethod: string | undefined;
  let calledAuth: string | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calledUrl = String(url);
    calledMethod = init?.method;
    calledAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.equal(result.openai, 'ok');
  assert.equal(calledUrl, 'https://api.openai.com/v1/models');
  assert.equal(calledMethod, 'GET');
  assert.equal(calledAuth, 'Bearer sk-fake-openai-key');
});

test('probeDependencies: all SIX dependencies report "ok" together when every one is configured and reachable (the full post-2026-08-28 happy path)', async () => {
  // Azure family + opensearch/openai go through the SAME mocked fetch (none of these tests care
  // about response body shape beyond "some JSON, status 200"; the per-dependency request-shape
  // assertions live in their own dedicated tests above). Postgres is the one real, unmocked
  // connection -- see the two probePostgres tests above for why a mock cannot stand in for it.
  process.env.COSMOS_ENDPOINT = 'https://fake-cosmos.example.com';
  process.env.COSMOS_KEY = Buffer.from('fake-key-material').toString('base64');
  process.env.AZURE_SEARCH_ENDPOINT = 'https://fake-search.example.com';
  process.env.AZURE_SEARCH_QUERY_KEY = 'fake-query-key';
  process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://fake-foundry.example.com';
  process.env.FOUNDRY_KEY = 'fake-foundry-key';
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = '5432';
  process.env.PG_DATABASE = 'agentstate_test';
  process.env.PG_USER = 'postgres';
  process.env.PG_PASSWORD = 'postgres';
  process.env.PG_SSL_VERIFY = 'false';
  process.env.OPENSEARCH_ENDPOINT = 'search-fake-domain.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'fake-access-key-id';
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret-access-key';
  process.env.OPENAI_API_KEY = 'sk-fake-openai-key';
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

  const { probeDependencies } = await import('./deep-health.js');
  const result = await probeDependencies();
  assert.deepEqual(result, {
    cosmos: 'ok',
    search: 'ok',
    foundry: 'ok',
    postgres: 'ok',
    opensearch: 'ok',
    openai: 'ok',
    postgres_tls_verify: false,
  });
});
