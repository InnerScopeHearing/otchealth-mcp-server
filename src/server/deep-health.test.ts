// Unit + regression coverage for the backend-aware /health/deep rewrite (2026-08-18).
//
// Two proofs the dispatching task explicitly requires, called out below where they live:
//   1. a MISSING SELECTOR errors rather than defaulting -- 'STATE_BACKEND unset errors, not "cosmos"'.
//   2. an UNREACHABLE ACTIVE backend reports 'down' -- 'state_rds/state_inbox: "down" against a real,
//      unreachable Postgres (connection refused)'.
//
// RDS-backed tests use a REAL local PostgreSQL 16 instance (127.0.0.1:5432, role postgres/postgres,
// database agentstate_test with the agentstate_queue table already provisioned) -- the same
// convention agentstate/queue-postgres.test.ts and its siblings use, rather than mocking `pg`.
// Every other probe (OpenSearch, S3, OpenAI, Tavily, SSM, Sentry) is a signed/bearer HTTPS call, so
// those are exercised by stubbing globalThis.fetch, matching search/opensearch.test.ts's convention.
//
// deep-health.ts reads every selector via process.env directly (never loadEnv()), so unlike
// loadEnv()-memoizing test files, ordinary beforeEach/afterEach env mutation is sufficient here --
// no need for the "own file per scenario" isolation queue-postgres.test.ts's siblings require.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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

const MANAGED_KEYS = [
  'STATE_BACKEND',
  'PG_HOST',
  'PG_PORT',
  'PG_DATABASE',
  'PG_USER',
  'PG_PASSWORD',
  'PG_SSL_VERIFY',
  'SEARCH_BACKEND',
  'OPENSEARCH_ENDPOINT',
  'OPENSEARCH_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'BLOB_BACKEND',
  'EMBEDDINGS_PROVIDER',
  'OPENAI_API_KEY',
  'LLM_PROVIDER',
  'OPENAI_CHAT_MODEL',
  'OPENAI_HIGH_MODEL',
  'WEB_SEARCH_PROVIDER',
  'TAVILY_API_KEY',
  'OAUTH_TOKEN_SIGNING_SECRET',
  'SENTRY_AUTH_TOKEN',
  'SENTRY_ORG',
];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const key of MANAGED_KEYS) delete process.env[key];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of MANAGED_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const dh = await import('./deep-health.js');

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

function throwingFetch(message = 'ECONNREFUSED'): void {
  globalThis.fetch = (async () => {
    throw new Error(message);
  }) as typeof fetch;
}

// ================================================================================================
// resolveSelector / selectorErrorResult -- the shared four-outcome machinery every backend-selecting
// probe is built on.
// ================================================================================================

test('resolveSelector: unset env var -> kind "missing"', () => {
  delete process.env.SEARCH_BACKEND;
  const sel = dh.resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  assert.equal(sel.kind, 'missing');
});

test('resolveSelector: empty-string env var -> kind "missing" (not "invalid")', () => {
  process.env.SEARCH_BACKEND = '';
  const sel = dh.resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  assert.equal(sel.kind, 'missing');
});

test('resolveSelector: the active value -> kind "active"', () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  const sel = dh.resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  assert.equal(sel.kind, 'active');
});

test('resolveSelector: the retired value -> kind "retired" (never defaults to it silently)', () => {
  process.env.SEARCH_BACKEND = 'azure';
  const sel = dh.resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  assert.equal(sel.kind, 'retired');
});

test('resolveSelector: an unrecognised value -> kind "invalid"', () => {
  process.env.SEARCH_BACKEND = 'gcp';
  const sel = dh.resolveSelector('SEARCH_BACKEND', 'opensearch', 'azure');
  assert.equal(sel.kind, 'invalid');
});

test('selectorErrorResult: every non-active kind produces a REQUIRED "error" that never ran', () => {
  for (const kind of ['missing', 'invalid', 'retired'] as const) {
    const sel = { raw: kind === 'missing' ? undefined : 'x', kind, envVar: 'X_BACKEND', active: 'aws', retired: 'azure' };
    const r = dh.selectorErrorResult(sel);
    assert.equal(r.status, 'error');
    assert.equal(r.required, true);
    assert.equal(r.ran, false);
    assert.equal(typeof r.error, 'string');
    assert.ok((r.error as string).length > 0);
  }
});

test('selectorErrorResult: the retired-backend message names the permanently deleted Azure subscription', () => {
  const r = dh.selectorErrorResult({ raw: 'azure', kind: 'retired', envVar: 'SEARCH_BACKEND', active: 'opensearch', retired: 'azure' });
  assert.match(r.error ?? '', /55c84f6b/);
  assert.match(r.error ?? '', /retired|deleted/i);
});

// ================================================================================================
// deriveOk -- the pure gate-verdict logic deploy.yml's step independently re-derives.
// ================================================================================================

test('deriveOk: true when every required probe is ok, regardless of an optional probe\'s status', () => {
  const probes = {
    a: { status: 'ok' as const, required: true, ran: true, backend: 'x' },
    b: { status: 'down' as const, required: false, ran: true, backend: 'y' },
  };
  assert.equal(dh.deriveOk(probes), true);
});

test('deriveOk: false when any required probe is not ok, regardless of status flavor (down/error/unconfigured)', () => {
  for (const badStatus of ['down', 'error', 'unconfigured'] as const) {
    const probes = {
      a: { status: 'ok' as const, required: true, ran: true, backend: 'x' },
      b: { status: badStatus, required: true, ran: true, backend: 'y' },
    };
    assert.equal(dh.deriveOk(probes), false, `expected false for required status "${badStatus}"`);
  }
});

// ================================================================================================
// probeStateBackends -- STATE_BACKEND (postgres active, cosmos retired). REAL local Postgres.
// ================================================================================================

const REAL_PG = { PG_HOST: '127.0.0.1', PG_PORT: '5432', PG_DATABASE: 'agentstate_test', PG_USER: 'postgres', PG_PASSWORD: 'postgres', PG_SSL_VERIFY: 'false' };

test('state_rds/state_inbox: STATE_BACKEND unset -> "error", never defaults to cosmos [REQUIRED RED PROOF: missing selector]', async () => {
  delete process.env.STATE_BACKEND;
  const { state_rds, state_inbox } = await dh.probeStateBackends();
  for (const r of [state_rds, state_inbox]) {
    assert.equal(r.status, 'error');
    assert.equal(r.required, true);
    assert.equal(r.ran, false);
    assert.match(r.error ?? '', /STATE_BACKEND/);
  }
});

test('state_rds/state_inbox: STATE_BACKEND=cosmos (the retired backend) -> "error", never attempts a connection', async () => {
  process.env.STATE_BACKEND = 'cosmos';
  const started = Date.now();
  const { state_rds, state_inbox } = await dh.probeStateBackends();
  const elapsedMs = Date.now() - started;
  for (const r of [state_rds, state_inbox]) {
    assert.equal(r.status, 'error');
    assert.equal(r.ran, false);
    assert.match(r.error ?? '', /cosmos/i);
  }
  // A real connection attempt against an unreachable/nonexistent Cosmos endpoint would take at
  // least one network round trip; a selector short-circuit returns near-instantly.
  assert.ok(elapsedMs < 500, `expected an instant short-circuit, took ${elapsedMs}ms`);
});

test('state_rds/state_inbox: STATE_BACKEND=postgres, gibberish value -> "error" (invalid selector)', async () => {
  process.env.STATE_BACKEND = 'sqlite';
  const { state_rds } = await dh.probeStateBackends();
  assert.equal(state_rds.status, 'error');
});

test('state_rds/state_inbox: STATE_BACKEND=postgres but PG_HOST unset -> "error"', async () => {
  process.env.STATE_BACKEND = 'postgres';
  const { state_rds, state_inbox } = await dh.probeStateBackends();
  for (const r of [state_rds, state_inbox]) {
    assert.equal(r.status, 'error');
    assert.equal(r.ran, false);
  }
});

test('state_rds/state_inbox: "down" against a real, unreachable Postgres (connection refused) [REQUIRED RED PROOF: unreachable backend]', async () => {
  process.env.STATE_BACKEND = 'postgres';
  process.env.PG_HOST = '127.0.0.1';
  process.env.PG_PORT = '5999'; // nothing listens here (mirrors queue-postgres-unreachable.test.ts)
  process.env.PG_DATABASE = 'agentstate_test';
  process.env.PG_USER = 'postgres';
  process.env.PG_PASSWORD = 'postgres';
  process.env.PG_SSL_VERIFY = 'false';

  const { state_rds, state_inbox } = await dh.probeStateBackends();
  for (const r of [state_rds, state_inbox]) {
    assert.equal(r.status, 'down');
    assert.equal(r.required, true);
    assert.equal(r.ran, true);
    assert.match(r.error ?? '', /ECONNREFUSED|connect|timeout/i);
  }
});

test('state_rds/state_inbox: both "ok" against the real local Postgres with agentstate_queue present', async () => {
  process.env.STATE_BACKEND = 'postgres';
  Object.assign(process.env, REAL_PG);

  const { state_rds, state_inbox } = await dh.probeStateBackends();
  assert.equal(state_rds.status, 'ok');
  assert.equal(state_rds.ran, true);
  assert.equal(state_inbox.status, 'ok');
  assert.equal(state_inbox.ran, true);
});

test('state_inbox: "down" (not "ok") against a real, reachable Postgres with NO agentstate_queue table -- a healthy-looking DB that cannot actually serve the agent inbox', async () => {
  const pg = (await import('pg')).default;
  const DB = 'agentstate_test_deep_health_no_queue';
  const admin = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres', ssl: { rejectUnauthorized: false } });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(DB).slice(1, -1)}`);
    await admin.query(`CREATE DATABASE ${JSON.stringify(DB).slice(1, -1)}`);
  } finally {
    await admin.end();
  }

  process.env.STATE_BACKEND = 'postgres';
  Object.assign(process.env, REAL_PG, { PG_DATABASE: DB });

  const { state_rds, state_inbox } = await dh.probeStateBackends();
  assert.equal(state_rds.status, 'ok', 'the connection itself is fine -- only the table is missing');
  assert.equal(state_inbox.status, 'down');
  assert.match(state_inbox.error ?? '', /agentstate_queue/);

  const cleanup = new pg.Pool({ host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres', ssl: { rejectUnauthorized: false } });
  try {
    await cleanup.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => undefined);
    await cleanup.query(`DROP DATABASE IF EXISTS ${JSON.stringify(DB).slice(1, -1)}`).catch(() => undefined);
  } finally {
    await cleanup.end();
  }
});

// ================================================================================================
// probeSearch -- SEARCH_BACKEND (opensearch active, azure retired).
// ================================================================================================

test('search_opensearch: SEARCH_BACKEND=azure (retired) -> "error", never calls fetch', async () => {
  process.env.SEARCH_BACKEND = 'azure';
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should never be called');
  }) as typeof fetch;
  const r = await dh.probeSearch();
  assert.equal(r.status, 'error');
  assert.equal(fetchCalled, false);
});

test('search_opensearch: active but OPENSEARCH_ENDPOINT unset -> "error"', async () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  const r = await dh.probeSearch();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
});

test('search_opensearch: active + endpoint but no AWS credentials -> "error"', async () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-xyz.us-east-1.es.amazonaws.com';
  const r = await dh.probeSearch();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
});

test('search_opensearch: "ok" on a real signed zero-result _search against memory-exec', async () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-xyz.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  let calledUrl = '';
  let calledMethod: string | undefined;
  let calledBody: string | undefined;
  stubFetch((url, init) => {
    calledUrl = url;
    calledMethod = init?.method;
    calledBody = init?.body as string | undefined;
    return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
  });
  const r = await dh.probeSearch();
  assert.equal(r.status, 'ok');
  assert.equal(r.backend, 'opensearch');
  assert.match(calledUrl, /\/memory-exec\/_search$/);
  assert.equal(calledMethod, 'POST');
  assert.equal(calledBody, JSON.stringify({ query: { match_all: {} }, size: 0 }));
});

test('search_opensearch: "down" on a network failure', async () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-xyz.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  throwingFetch();
  const r = await dh.probeSearch();
  assert.equal(r.status, 'down');
});

test('search_opensearch: "down" on a 200 response that does not look like an OpenSearch _search result', async () => {
  process.env.SEARCH_BACKEND = 'opensearch';
  process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-xyz.us-east-1.es.amazonaws.com';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const r = await dh.probeSearch();
  assert.equal(r.status, 'down');
  assert.match(r.error ?? '', /hits/);
});

// ================================================================================================
// probeBlob -- BLOB_BACKEND (s3 active, azure retired).
// ================================================================================================

test('blob_s3: BLOB_BACKEND=azure (retired) -> "error", never calls fetch', async () => {
  process.env.BLOB_BACKEND = 'azure';
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should never be called');
  }) as typeof fetch;
  const r = await dh.probeBlob();
  assert.equal(r.status, 'error');
  assert.equal(fetchCalled, false);
});

test('blob_s3: "ok" when both the commons and document mirror buckets answer with a valid ListBucketResult', async () => {
  process.env.BLOB_BACKEND = 's3';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const calledHosts: string[] = [];
  stubFetch((url) => {
    calledHosts.push(new URL(url).host);
    return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', { status: 200 });
  });
  const r = await dh.probeBlob();
  assert.equal(r.status, 'ok');
  // Two DISTINCT physical buckets were actually hit -- the commons mirror and a document-room
  // mirror -- not the same bucket queried twice.
  assert.equal(new Set(calledHosts).size, 2);
  assert.ok(calledHosts.some((h) => h.includes('otchealth-brain-dr')));
  assert.ok(calledHosts.some((h) => h.includes('otchealth-finance-legal-dr')));
});

test('blob_s3: "down" when only ONE of the two mirror buckets fails (does not hide behind the other succeeding)', async () => {
  process.env.BLOB_BACKEND = 's3';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  stubFetch((url) => {
    if (new URL(url).host.includes('otchealth-brain-dr')) {
      return new Response('access denied', { status: 403 });
    }
    return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', { status: 200 });
  });
  const r = await dh.probeBlob();
  assert.equal(r.status, 'down');
  assert.match(r.error ?? '', /otchealthcommons/);
});

// ================================================================================================
// probeEmbeddings / probeLlm -- EMBEDDINGS_PROVIDER / LLM_PROVIDER (openai active, foundry retired).
// ================================================================================================

test('embeddings_openai: EMBEDDINGS_PROVIDER=foundry (retired) -> "error", never calls fetch', async () => {
  process.env.EMBEDDINGS_PROVIDER = 'foundry';
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should never be called');
  }) as typeof fetch;
  const r = await dh.probeEmbeddings();
  assert.equal(r.status, 'error');
  assert.equal(fetchCalled, false);
});

test('embeddings_openai: active but OPENAI_API_KEY unset -> "error"', async () => {
  process.env.EMBEDDINGS_PROVIDER = 'openai';
  const r = await dh.probeEmbeddings();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
});

test('embeddings_openai: "ok" on a free GET /v1/models/{id} metadata call (never a billed embedding)', async () => {
  process.env.EMBEDDINGS_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  let calledUrl = '';
  let calledMethod: string | undefined;
  stubFetch((url, init) => {
    calledUrl = url;
    calledMethod = init?.method;
    return new Response(JSON.stringify({ id: 'text-embedding-3-large' }), { status: 200 });
  });
  const r = await dh.probeEmbeddings();
  assert.equal(r.status, 'ok');
  assert.equal(calledMethod, 'GET');
  assert.match(calledUrl, /\/v1\/models\/text-embedding-3-large$/);
});

test('embeddings_openai: "down" on a 404 (model not available under this key)', async () => {
  process.env.EMBEDDINGS_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  stubFetch(() => new Response(JSON.stringify({ error: 'model_not_found' }), { status: 404 }));
  const r = await dh.probeEmbeddings();
  assert.equal(r.status, 'down');
});

test('llm_openai: LLM_PROVIDER=foundry (retired) -> "error"', async () => {
  process.env.LLM_PROVIDER = 'foundry';
  const r = await dh.probeLlm();
  assert.equal(r.status, 'error');
});

test('llm_openai: "ok" when both the standard and high-tier models are reachable', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_CHAT_MODEL = 'gpt-5.1';
  process.env.OPENAI_HIGH_MODEL = 'gpt-5.4';
  const calledUrls: string[] = [];
  stubFetch((url) => {
    calledUrls.push(url);
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  });
  const r = await dh.probeLlm();
  assert.equal(r.status, 'ok');
  assert.ok(calledUrls.some((u) => u.endsWith('/v1/models/gpt-5.1')));
  assert.ok(calledUrls.some((u) => u.endsWith('/v1/models/gpt-5.4')));
});

test('llm_openai: "down" and NAMES which tier failed when only the high-tier model is unreachable', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_CHAT_MODEL = 'gpt-5.1';
  process.env.OPENAI_HIGH_MODEL = 'gpt-5.4';
  stubFetch((url) => {
    if (url.endsWith('/v1/models/gpt-5.4')) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  });
  const r = await dh.probeLlm();
  assert.equal(r.status, 'down');
  assert.match(r.error ?? '', /high/);
  assert.doesNotMatch(r.error ?? '', /standard\("gpt-5\.1"\): HTTP (?!200)/);
});

// ================================================================================================
// probeWebSearch -- WEB_SEARCH_PROVIDER (tavily active, azure retired).
// ================================================================================================

test('web_search_tavily: WEB_SEARCH_PROVIDER=azure (retired) -> "error"', async () => {
  process.env.WEB_SEARCH_PROVIDER = 'azure';
  const r = await dh.probeWebSearch();
  assert.equal(r.status, 'error');
});

test('web_search_tavily: active but TAVILY_API_KEY unset -> "error"', async () => {
  process.env.WEB_SEARCH_PROVIDER = 'tavily';
  const r = await dh.probeWebSearch();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
});

test('web_search_tavily: "ok" on a reachable search, "down" on a non-2xx', async () => {
  process.env.WEB_SEARCH_PROVIDER = 'tavily';
  process.env.TAVILY_API_KEY = 'tvly-test';
  stubFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  const ok = await dh.probeWebSearch();
  assert.equal(ok.status, 'ok');

  stubFetch(() => new Response('unauthorized', { status: 401 }));
  const down = await dh.probeWebSearch();
  assert.equal(down.status, 'down');
});

// ================================================================================================
// probeSsm -- always runs (no selector); task-role SSM reachability.
// ================================================================================================

test('ssm: no AWS credentials -> "error"', async () => {
  const r = await dh.probeSsm();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
});

test('ssm: "ok" on a valid GetParametersByPath response, NEVER requests decryption', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  let calledBody = '';
  stubFetch((_url, init) => {
    calledBody = init?.body as string;
    return new Response(JSON.stringify({ Parameters: [{ Name: '/otchealth/example' }] }), { status: 200 });
  });
  const r = await dh.probeSsm();
  assert.equal(r.status, 'ok');
  const parsed = JSON.parse(calledBody);
  assert.equal(parsed.WithDecryption, false);
  assert.equal(parsed.MaxResults, 1);
  assert.equal(parsed.Path, '/otchealth/');
});

test('ssm: "down" on an AccessDenied-shaped failure', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  stubFetch(() => new Response(JSON.stringify({ __type: 'AccessDeniedException' }), { status: 400 }));
  const r = await dh.probeSsm();
  assert.equal(r.status, 'down');
});

// ================================================================================================
// probeIdentity -- in-process OAuth sign/verify + lane mapping. No network call ever.
// ================================================================================================

test('identity_oauth: OAUTH_TOKEN_SIGNING_SECRET unset -> "error", never touches fetch', async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should never be called');
  }) as typeof fetch;
  const r = await dh.probeIdentity();
  assert.equal(r.status, 'error');
  assert.equal(r.ran, false);
  assert.equal(fetchCalled, false);
});

test('identity_oauth: "ok" -- real sign/verify round-trip + default scope->lane mapping, no network', async () => {
  process.env.OAUTH_TOKEN_SIGNING_SECRET = 'test-signing-secret';
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('identity probe must never call fetch');
  }) as typeof fetch;
  const r = await dh.probeIdentity();
  assert.equal(r.status, 'ok');
  assert.equal(r.ran, true);
  assert.equal(fetchCalled, false);
});

// ================================================================================================
// probeSentryOptional -- required: false, never gates the deploy regardless of its own status.
// ================================================================================================

test('sentry: no SENTRY_AUTH_TOKEN -> "unconfigured", required: false', async () => {
  const r = await dh.probeSentryOptional();
  assert.equal(r.status, 'unconfigured');
  assert.equal(r.required, false);
  assert.equal(r.ran, false);
});

test('sentry: configured + reachable -> "ok", required: false', async () => {
  process.env.SENTRY_AUTH_TOKEN = 'sntrys_test';
  stubFetch(() => new Response(JSON.stringify({ slug: 'otchealth-inc' }), { status: 200 }));
  const r = await dh.probeSentryOptional();
  assert.equal(r.status, 'ok');
  assert.equal(r.required, false);
});

test('sentry: configured + unreachable -> "down", but still required: false (an optional failure never gates the deploy)', async () => {
  process.env.SENTRY_AUTH_TOKEN = 'sntrys_test';
  throwingFetch();
  const r = await dh.probeSentryOptional();
  assert.equal(r.status, 'down');
  assert.equal(r.required, false);
  // Prove the gating consequence directly through the real deriveOk() logic, not just the flag.
  const probes = { sentry: r, other: { status: 'ok' as const, required: true, ran: true, backend: 'x' } };
  assert.equal(dh.deriveOk(probes), true, 'a down OPTIONAL probe must not flip the overall gate to false');
});

// ================================================================================================
// probeDependencies -- full end-to-end aggregate, every backend active + reachable, and one
// end-to-end failure case.
// ================================================================================================

function routeFetch(url: string): Response {
  const u = new URL(url);
  if (u.host.includes('.es.amazonaws.com')) {
    return new Response(JSON.stringify({ hits: { total: { value: 0 }, hits: [] } }), { status: 200 });
  }
  if (u.host.endsWith('.s3.us-east-1.amazonaws.com')) {
    return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', { status: 200 });
  }
  if (u.host === 'api.openai.com') {
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  }
  if (u.host === 'api.tavily.com') {
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }
  if (u.host.startsWith('ssm.')) {
    return new Response(JSON.stringify({ Parameters: [] }), { status: 200 });
  }
  throw new Error(`unrouted fetch in probeDependencies aggregate test: ${url}`);
}

function setEveryBackendActiveAndConfigured(): void {
  process.env.STATE_BACKEND = 'postgres';
  Object.assign(process.env, REAL_PG);
  process.env.SEARCH_BACKEND = 'opensearch';
  process.env.OPENSEARCH_ENDPOINT = 'search-otchealth-brain-xyz.us-east-1.es.amazonaws.com';
  process.env.BLOB_BACKEND = 's3';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  process.env.EMBEDDINGS_PROVIDER = 'openai';
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.WEB_SEARCH_PROVIDER = 'tavily';
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.OAUTH_TOKEN_SIGNING_SECRET = 'test-signing-secret';
}

test('probeDependencies: ok=true end-to-end when every backend is active, configured, and reachable', async () => {
  setEveryBackendActiveAndConfigured();
  stubFetch((url) => routeFetch(url));

  const report = await dh.probeDependencies();
  assert.equal(report.ok, true);
  for (const [name, p] of Object.entries(report.probes)) {
    if (p.required) assert.equal(p.status, 'ok', `expected ${name} to be ok, got ${p.status}: ${p.error}`);
  }
  // Structured/summary agreement: re-derive independently from the same probes map, matching
  // deploy.yml's own defense against server/structured drift.
  assert.equal(dh.deriveOk(report.probes), report.ok);
});

test('probeDependencies: ok=false end-to-end when exactly one required backend is misconfigured (retired selector), everything else healthy', async () => {
  setEveryBackendActiveAndConfigured();
  process.env.LLM_PROVIDER = 'foundry'; // the one deliberate failure: points at the retired backend
  stubFetch((url) => routeFetch(url));

  const report = await dh.probeDependencies();
  assert.equal(report.ok, false);
  assert.equal(report.probes.llm_openai.status, 'error');
  assert.equal(report.probes.llm_openai.required, true);
  // Every OTHER required probe still succeeded -- one bad selector does not mask the rest.
  for (const [name, p] of Object.entries(report.probes)) {
    if (name === 'llm_openai' || !p.required) continue;
    assert.equal(p.status, 'ok', `expected ${name} to still be ok, got ${p.status}: ${p.error}`);
  }
  assert.equal(dh.deriveOk(report.probes), report.ok);
});
