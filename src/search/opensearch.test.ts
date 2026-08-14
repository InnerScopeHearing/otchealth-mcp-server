import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExhaustFilterClause } from '../memory/room-hygiene.js';
import { buildTypeInFilterClause, INCIDENT_TYPES } from '../safety/incident-match.js';

// Required-var preamble (mirrors azure/search.test.ts / dispatch-opensearch.test.ts). BOTH Azure
// and OpenSearch are left configured here (unlike dispatch-opensearch.test.ts, which deletes the
// Azure vars to prove routing isolation) -- this file's "result-shape parity" test deliberately
// runs BOTH clients directly (never through the dispatcher) side by side against equivalent stub
// responses, so both need to be configured in the same process.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';
process.env.OPENSEARCH_ENDPOINT ||= 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';
process.env.OPENSEARCH_REGION ||= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ||= 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ||= 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const openSearchClient = await import('./opensearch.js');
const azureClient = await import('../azure/search.js');
const { hybridSearch, getDocumentByKey, searchConfigured, vectorFieldFor, reciprocalRankFusion, translateODataFilter } =
  openSearchClient;

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isEmbeddingsUrl(url: string): boolean {
  return url.includes('/openai/deployments/') && url.includes('/embeddings');
}

function embeddingsOk(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
}

const OS_HOST = 'search-otchealth-brain-uqmq2jw23cv4yjnnxblxzb7nny.us-east-1.es.amazonaws.com';

// ================================================================================================
// vectorFieldFor -- the task's fixed 15-index room registry, asserted verbatim per index. This
// pins BOTH which rooms are chunked (text_vector) and which are flat (contentVector) exactly as
// given in the task description, via the SAME isChunkedRoom registry azure/search.ts owns.
// ================================================================================================

const CHUNKED_ROOMS_EXPECTED = [
  'commerce-commerce-source-docs',
  'commons-company-journal',
  'finance-cfo-source-docs',
  'legal-company',
  'legal-personal',
];

const FLAT_ROOMS_EXPECTED = [
  'commons-cco-memory',
  'commons-coo-memory',
  'commons-cpo-memory',
  'commons-cro-memory',
  'commons-developer-memory',
  'cs-knowledge',
  'finance-cfo-memory',
  'finance-otchealth-cfo-source-docs',
  'legal-personal-memory',
  'memory-exec',
];

test('vectorFieldFor: every CHUNKED room (per the task spec) resolves to text_vector', () => {
  for (const room of CHUNKED_ROOMS_EXPECTED) {
    assert.equal(vectorFieldFor(room), 'text_vector', `${room} should be text_vector`);
  }
});

test('vectorFieldFor: every FLAT/memory room (per the task spec) resolves to contentVector', () => {
  for (const room of FLAT_ROOMS_EXPECTED) {
    assert.equal(vectorFieldFor(room), 'contentVector', `${room} should be contentVector`);
  }
});

test('vectorFieldFor: the two lists above cover exactly the 15 named indexes with no overlap', () => {
  assert.equal(CHUNKED_ROOMS_EXPECTED.length + FLAT_ROOMS_EXPECTED.length, 15);
  const overlap = CHUNKED_ROOMS_EXPECTED.filter((r) => FLAT_ROOMS_EXPECTED.includes(r));
  assert.deepEqual(overlap, []);
});

test('vectorFieldFor: an unrecognized index name defaults to contentVector (flat), never throws', () => {
  assert.equal(vectorFieldFor('some-future-room-nobody-registered-yet'), 'contentVector');
});

test('hybridSearch: the actual k-NN request body keys the vector under the room-correct field name', async () => {
  const capturedFields = { chunked: undefined as string | undefined, flat: undefined as string | undefined };
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (u.startsWith(`https://${OS_HOST}/legal-company/_search`)) {
        const body = JSON.parse(String(init?.body)) as { query?: { knn?: Record<string, unknown> } };
        if (body.query?.knn) capturedFields.chunked = Object.keys(body.query.knn)[0];
        return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      }
      if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
        const body = JSON.parse(String(init?.body)) as { query?: { knn?: Record<string, unknown> } };
        if (body.query?.knn) capturedFields.flat = Object.keys(body.query.knn)[0];
        return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    async () => {
      await hybridSearch('legal-company', 'q', 5); // chunked room
      await hybridSearch('memory-exec', 'q', 5); // flat room
    },
  );
  assert.equal(capturedFields.chunked, 'text_vector');
  assert.equal(capturedFields.flat, 'contentVector');
});

// ================================================================================================
// reciprocalRankFusion -- pure, direct.
// ================================================================================================

test('reciprocalRankFusion: a single list scores each doc 1/(k+rank), rank 1-indexed', () => {
  const scores = reciprocalRankFusion([[{ id: 'a', score: 9, source: {} }, { id: 'b', score: 8, source: {} }]], 60);
  assert.equal(scores.get('a'), 1 / 61);
  assert.equal(scores.get('b'), 1 / 62);
});

test('reciprocalRankFusion: a doc appearing in BOTH lists sums its per-list RRF contributions', () => {
  const bm = [{ id: 'a', score: 5, source: {} }, { id: 'b', score: 4, source: {} }];
  const vec = [{ id: 'b', score: 0.9, source: {} }, { id: 'a', score: 0.8, source: {} }];
  const scores = reciprocalRankFusion([bm, vec], 60);
  // a: rank1 in bm (1/61) + rank2 in vec (1/62); b: rank2 in bm (1/62) + rank1 in vec (1/61).
  assert.equal(scores.get('a'), 1 / 61 + 1 / 62);
  assert.equal(scores.get('b'), 1 / 62 + 1 / 61);
  assert.equal(scores.get('a'), scores.get('b'), 'symmetric ranks across two lists must tie');
});

test('reciprocalRankFusion: a hit with an empty/falsy id is skipped, never pollutes the score map', () => {
  const scores = reciprocalRankFusion([[{ id: '', score: 9, source: {} }, { id: 'real', score: 1, source: {} }]]);
  assert.equal(scores.size, 1);
  assert.ok(scores.has('real'));
});

test('reciprocalRankFusion: an empty list of lists returns an empty map, never throws', () => {
  assert.equal(reciprocalRankFusion([]).size, 0);
  assert.equal(reciprocalRankFusion([[]]).size, 0);
});

// ================================================================================================
// translateODataFilter -- exercised against the REAL filter strings the gateway's two actual
// callers generate (room-hygiene's exhaust ne-chain, incident-match's type in-chain), not just
// hand-written approximations, so this is a genuine end-to-end check of the translation this
// gateway will actually ask for.
// ================================================================================================

test('translateODataFilter: room-hygiene\'s REAL exhaust ne-chain translates to a must_not terms clause', () => {
  const real = buildExhaustFilterClause(); // "type ne 'status' and type ne 'episode' and ..."
  const translated = translateODataFilter(real);
  assert.ok(translated);
  assert.equal(translated!.must, undefined);
  assert.deepEqual(translated!.mustNot, [
    { terms: { type: ['status', 'episode', 'heartbeat', 'fleet-watch', 'digest', 'compaction-digest', 'compaction-note'] } },
  ]);
});

test('translateODataFilter: incident-match\'s REAL type in-chain translates to a must terms clause', () => {
  const real = buildTypeInFilterClause(INCIDENT_TYPES); // "type eq 'pitfall' or type eq 'correction'"
  const translated = translateODataFilter(real);
  assert.ok(translated);
  assert.equal(translated!.mustNot, undefined);
  assert.deepEqual(translated!.must, [{ terms: { type: ['pitfall', 'correction'] } }]);
});

test('translateODataFilter: undefined filter -> null (no filter applied)', () => {
  assert.equal(translateODataFilter(undefined), null);
});

test('translateODataFilter: an unrecognized shape fails OPEN to null rather than guessing', () => {
  assert.equal(translateODataFilter("path startswith '/legal/'"), null);
  assert.equal(translateODataFilter('garbage not odata at all'), null);
});

test('translateODataFilter: a MIXED eq+ne filter is not confidently parseable -> null', () => {
  assert.equal(translateODataFilter("type eq 'fact' and type ne 'status'"), null);
});

test('translateODataFilter: an OData-escaped single quote (\'\') round-trips to a literal quote', () => {
  const translated = translateODataFilter("type ne 'it''s-a-type'");
  assert.deepEqual(translated, { mustNot: [{ terms: { type: ["it's-a-type"] } }] });
});

// ================================================================================================
// hybridSearch: filter opt-in actually reaches BOTH the BM25 bool query and the k-NN pre-filter.
// ================================================================================================

test('hybridSearch: opts.filter (room-hygiene exhaust clause) is threaded into both BM25 must_not and the knn pre-filter', async () => {
  let bm25MustNot: unknown;
  let knnFilter: unknown;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
        const body = JSON.parse(String(init?.body)) as {
          query?: { bool?: { must_not?: unknown }; knn?: Record<string, { filter?: unknown }> };
        };
        if (body.query?.bool) bm25MustNot = body.query.bool.must_not;
        if (body.query?.knn) knnFilter = body.query.knn['contentVector']?.filter;
        return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'q', 5, { filter: buildExhaustFilterClause() });
      assert.ok(res);
    },
  );
  assert.deepEqual(bm25MustNot, [{ terms: { type: ['status', 'episode', 'heartbeat', 'fleet-watch', 'digest', 'compaction-digest', 'compaction-note'] } }]);
  assert.deepEqual(knnFilter, { bool: { must_not: [{ terms: { type: ['status', 'episode', 'heartbeat', 'fleet-watch', 'digest', 'compaction-digest', 'compaction-note'] } }] } });
});

test('hybridSearch: a CHUNKED room never gets a filter, even when opts.filter is given (no `type` field on doc rooms)', async () => {
  let sawFilter = false;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (u.startsWith(`https://${OS_HOST}/legal-company/_search`)) {
        const body = JSON.parse(String(init?.body)) as { query?: { bool?: { filter?: unknown; must_not?: unknown } } };
        if (body.query?.bool?.filter || body.query?.bool?.must_not) sawFilter = true;
        return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    async () => {
      await hybridSearch('legal-company', 'q', 5, { filter: buildExhaustFilterClause() });
    },
  );
  assert.equal(sawFilter, false);
});

// ================================================================================================
// hybridSearch: fail-open contract -- at most one fallback attempt, never a redundant third call.
// ================================================================================================

// NOTE on status choice: fetchWithBudget (src/util/fetch-budget.ts) transparently retries ONCE,
// INSIDE itself, on a 429 or 5xx response or a thrown network error -- so a 500 stub would make
// each single LOGICAL signedSearchFetch call cost up to 2 RAW fetch() invocations, which is a
// property of that shared helper, not of opensearch.ts's own fallback logic. These tests use 400
// (never retried by fetchWithBudget: isRetryableStatus only covers 429/5xx) so the raw call count
// maps 1:1 to opensearch.ts's own logical attempts, cleanly isolating the exact bug that was fixed
// here from fetchWithBudget's unrelated, orthogonal retry layer. Embeddings are also made to fail
// so hybridSearch degrades to keyword-only and never issues a separate k-NN call against the same
// `/memory-exec/_search` URL, which would otherwise add an uncontrolled extra call to the count.

test('hybridSearch: a genuine double-failure (primary AND fallback both non-2xx) makes EXACTLY 2 calls, then throws', async () => {
  let searchCalls = 0;
  await assert.rejects(
    withStubbedFetch(
      (async (url: string | URL) => {
        const u = String(url);
        if (isEmbeddingsUrl(u)) return new Response('embeddings down', { status: 500 });
        if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
          searchCalls++;
          return new Response('bad request', { status: 400 });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }) as typeof fetch,
      () => hybridSearch('memory-exec', 'q', 5, { filter: buildExhaustFilterClause() }),
    ),
    /opensearch search 400/,
  );
  assert.equal(searchCalls, 2, 'must not retry the identical filter-free fallback a redundant third time');
});

test('hybridSearch: a thrown network error on the primary attempt is recovered by the one fallback attempt (result still returned, not thrown)', async () => {
  let searchCalls = 0;
  const res = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return new Response('embeddings down', { status: 500 });
      if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
        searchCalls++;
        if (searchCalls === 1) throw new Error('ECONNRESET'); // primary attempt: hard network failure
        return new Response(JSON.stringify({ hits: { hits: [{ _id: 'x', _score: 1, _source: { text: 'recovered' } }] } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => hybridSearch('memory-exec', 'q', 5, { filter: buildExhaustFilterClause() }),
  );
  assert.ok(res, 'the fallback attempt after a thrown primary error must still produce a result, not propagate the exception');
  assert.equal(res!.matches[0]?.text, 'recovered');
  // At least 2 (primary threw once, fallback succeeded) -- not pinned to an exact number since a
  // thrown error is ALSO subject to fetchWithBudget's own internal one-retry-on-network-error,
  // which is an orthogonal layer to the behavior this test targets (see the note above).
  assert.ok(searchCalls >= 2);
});

// ================================================================================================
// hybridSearch: keyword-only degradation when embed() fails.
// ================================================================================================

test('hybridSearch: an embed() failure degrades to keyword-only (mode "keyword", no knn query sent)', async () => {
  let sawKnnCall = false;
  const res = await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return new Response('embedding service down', { status: 500 });
      if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
        const body = JSON.parse(String(init?.body)) as { query?: { knn?: unknown } };
        if (body.query?.knn) sawKnnCall = true;
        return new Response(
          JSON.stringify({ hits: { hits: [{ _id: 'x', _score: 1, _source: { text: 'kw only' } }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => hybridSearch('memory-exec', 'q', 5, { includeOps: true }),
  );
  assert.ok(res);
  assert.equal(res!.mode, 'keyword');
  assert.equal(sawKnnCall, false, 'no knn body should ever be constructed when embed() failed');
});

// ================================================================================================
// Result-shape parity with the Azure client: same logical hit, both engines, same KbHit field set.
// ================================================================================================

test('result shape parity: OpenSearch and Azure return the SAME KbHit key set for an equivalent flat-room hit', async () => {
  const DOC_FIELDS = { type: 'fact', text: 'the ASC key id is 9MR7PJHRYH', ts: '2026-06-17T00:00:00Z', source: 'Matt 2026-06-17', by: 'cto' };

  const azureRes = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (u.includes('otchealth-dataroom-search.example.invalid') && u.includes('/docs/search')) {
        return new Response(
          JSON.stringify({ value: [{ id: 'cto__1', '@search.rerankerScore': 3.0, ...DOC_FIELDS }] }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => azureClient.hybridSearch('memory-exec', 'q', 5, { includeOps: false }),
  );

  const openSearchRes = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (u.startsWith(`https://${OS_HOST}/memory-exec/_search`)) {
        return new Response(
          JSON.stringify({ hits: { hits: [{ _id: 'cto__1', _score: 3.0, _source: DOC_FIELDS }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => hybridSearch('memory-exec', 'q', 5, { includeOps: false }),
  );

  assert.ok(azureRes && azureRes.matches.length === 1);
  assert.ok(openSearchRes && openSearchRes.matches.length === 1);

  const azureKeys = Object.keys(azureRes!.matches[0]).sort();
  const osKeys = Object.keys(openSearchRes!.matches[0]).sort();
  assert.deepEqual(osKeys, azureKeys, 'OpenSearch must expose exactly the same KbHit keys Azure does for this hit');
  assert.deepEqual(azureKeys, ['id', 'path', 'score', 'text', 'type'].filter((k) => azureKeys.includes(k)).sort(), 'sanity: no unexpected key leaked through on the Azure side either');

  // Internal ranking-signal fields (ts/source/by/_parent) must never leak into either engine's
  // public output -- they exist only to feed the authority re-rank + room-hygiene demotion.
  for (const leaked of ['ts', 'source', 'by', '_parent']) {
    assert.ok(!(leaked in openSearchRes!.matches[0]), `OpenSearch must not leak internal field "${leaked}"`);
    assert.ok(!(leaked in azureRes!.matches[0]), `Azure must not leak internal field "${leaked}" (sanity check)`);
  }

  // Shared, comparable fields carry the SAME values (score is engine-specific and intentionally not
  // compared: Azure returns its rerankerScore, OpenSearch returns an RRF score on a different scale).
  assert.equal(openSearchRes!.matches[0].id, azureRes!.matches[0].id);
  assert.equal(openSearchRes!.matches[0].text, azureRes!.matches[0].text);
  assert.equal(openSearchRes!.matches[0].type, azureRes!.matches[0].type);
});

// ================================================================================================
// searchConfigured -- the "true" branch only lives here (it is exactly this file's own preamble
// config). The other three branches (endpoint unset; endpoint set with no credential signal at
// all; endpoint set with only the ECS container-credentials fallback signal) each need a DIFFERENT
// process.env snapshot at the moment config/env.ts's loadEnv() is FIRST called in a process --
// loadEnv() caches its parsed result for the lifetime of the module (see config/env.ts's `cached`
// module-scope variable), so mutating process.env AFTER that first call, mid-file, has NO effect
// on what loadEnv() returns to searchConfigured() from then on (this was tried here first and
// produced false-positive/false-negative results precisely because of that cache -- deleting
// AWS_ACCESS_KEY_ID mid-test did not stop `e.AWS_ACCESS_KEY_ID` from reading the ALREADY-CACHED
// value from this file's own top-of-file preamble). Those three branches get their own dedicated,
// minimal test files instead (own file = own process = a fresh, never-yet-called loadEnv(), the
// SAME discipline dispatch-azure.test.ts / dispatch-opensearch.test.ts already establish for
// SEARCH_BACKEND): src/search/opensearch-unconfigured.test.ts,
// src/search/opensearch-ecs-fallback.test.ts, src/search/opensearch-no-credentials.test.ts.
// ================================================================================================

test('searchConfigured: true when the endpoint is set and explicit AWS keys are present', () => {
  assert.equal(searchConfigured(), true); // set by this file's preamble
});

// ================================================================================================
// getDocumentByKey
// ================================================================================================

test('getDocumentByKey: flat room, 200 -> returns the doc with mode "direct"', async () => {
  const res = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u === `https://${OS_HOST}/memory-exec/_doc/cto__1`) {
        return new Response(JSON.stringify({ found: true, _source: { title: 'T', text: 'hello', path: 'p/q' } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => getDocumentByKey('memory-exec', 'cto__1'),
  );
  assert.deepEqual(res, { key: 'cto__1', title: 'T', text: 'hello', path: 'p/q', mode: 'direct' });
});

test('getDocumentByKey: flat room, 404 -> null (not an error)', async () => {
  const res = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ found: false }), { status: 404 })) as typeof fetch,
    () => getDocumentByKey('memory-exec', 'missing-key'),
  );
  assert.equal(res, null);
});

test('getDocumentByKey: chunked room reassembles chunks in ordinal order regardless of response order', async () => {
  const res = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith(`https://${OS_HOST}/legal-company/_search`)) {
        return new Response(
          JSON.stringify({
            hits: {
              hits: [
                { _id: 'k#2', _score: 1, _source: { chunk_id: 'parent#2', chunk: 'second.', title: 'Doc', path: 'legal/doc.md' } },
                { _id: 'k#0', _score: 1, _source: { chunk_id: 'parent#0', chunk: 'first.', title: 'Doc', path: 'legal/doc.md' } },
                { _id: 'k#1', _score: 1, _source: { chunk_id: 'parent#1', chunk: 'middle.', title: 'Doc', path: 'legal/doc.md' } },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch,
    () => getDocumentByKey('legal-company', 'parent'),
  );
  assert.ok(res);
  assert.equal(res!.mode, 'reassembled');
  assert.equal(res!.text, 'first.\n\nmiddle.\n\nsecond.');
  assert.equal(res!.path, 'legal/doc.md');
});

test('getDocumentByKey: chunked room -- a thrown network error on the primary term-filter query still falls back to the keyword search', async () => {
  let calls = 0;
  const res = await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (!u.startsWith(`https://${OS_HOST}/legal-company/_search`)) throw new Error(`unexpected fetch: ${u}`);
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return new Response(
        JSON.stringify({
          hits: { hits: [{ _id: 'k#0', _score: 1, _source: { chunk_id: 'parent#0', chunk: 'recovered.', parent_id: 'parent', path: 'legal/doc.md' } }] },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    () => getDocumentByKey('legal-company', 'parent'),
  );
  assert.ok(res, 'a thrown error on the primary attempt must still get the one fallback try');
  assert.equal(res!.text, 'recovered.');
  assert.equal(calls, 2);
});

test('getDocumentByKey: no matching chunks -> null', async () => {
  const res = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 })) as typeof fetch,
    () => getDocumentByKey('legal-company', 'nope'),
  );
  assert.equal(res, null);
});

// The "no OPENSEARCH_ENDPOINT configured" branch is covered in the dedicated
// opensearch-unconfigured.test.ts (see the searchConfigured section above for why: loadEnv()'s
// process-wide cache means this file's own already-configured endpoint cannot be un-set mid-file).
test('getDocumentByKey: an empty key -> null immediately, no network call at all', async () => {
  const res = await withStubbedFetch(
    (async (url: string | URL) => {
      throw new Error(`getDocumentByKey with an empty key must never fetch anything, got: ${String(url)}`);
    }) as typeof fetch,
    () => getDocumentByKey('memory-exec', ''),
  );
  assert.equal(res, null);
});
