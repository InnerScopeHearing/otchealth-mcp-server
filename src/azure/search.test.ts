import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (foundry.ts's cfg() goes through loadEnv), then configure both
// Foundry and Azure AI Search so hybridSearch's real code paths (not the 'unconfigured' early
// return) run. Mirrors src/memory/agentic.test.ts's preamble exactly.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin the pre-2026-08-28 backend defaults (env.ts's SEARCH_BACKEND/EMBEDDINGS_PROVIDER/
// LLM_PROVIDER/WEB_SEARCH_PROVIDER/BLOB_BACKEND/STATE_BACKEND now default to their AWS-native
// replacements) so this file keeps exercising exactly the Azure/Foundry/Cosmos code path it was
// written for -- those paths stay inert-but-present and still need this coverage.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { hybridSearch } = await import('./search.js');

// Pure network mocking via globalThis.fetch (a genuine global, not a module export) — the same
// seam src/util/fetch-budget.test.ts and src/memory/agentic.test.ts use, since this repo's ESM
// build does not let node:test's mock.method() redefine another module's live named export.
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

function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}

function embeddingsOk(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
}

const MIXED_DOCS = [
  { id: 'cto__1', type: 'fact', text: 'the ASC key id is 9MR7PJHRYH', '@search.rerankerScore': 3.1 },
  { id: 'cto__2', type: 'status', text: 'still working on the PlantID backend', '@search.rerankerScore': 3.0 },
  { id: 'cto__3', type: 'decision', text: 'ship build 46', '@search.rerankerScore': 2.9 },
  { id: 'cto__4', type: 'compaction-digest', text: '42 status rows between X and Y', '@search.rerankerScore': 2.8 },
];

// --- behavior 1: exhaust DEPRIORITIZED (demoted, not deleted) BY DEFAULT when the tool layer opts
// in (opts.includeOps=false) -- 2026-07-21: a hard server-side $filter can only exclude, never
// demote, so the default path no longer builds or sends one; demotion happens client-side, after
// retrieval, once the exhaust rows are actually in hand to be re-ranked. ---

test('hybridSearch: includeOps=false sends NO server-side filter -- demotion is a client-side re-rank, not a query-time exclude', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: [MIXED_DOCS[0], MIXED_DOCS[2]] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'ASC key id', 10, { includeOps: false });
      assert.ok(res);
      assert.equal(capturedBody?.filter, undefined, 'no $filter should be sent by default, even with includeOps:false');
    },
  );
});

test('hybridSearch: includeOps=false DEMOTES exhaust-typed docs (moved after genuine hits) rather than dropping them', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        // A mix of exhaust + knowledge docs, unfiltered (the only kind of response the default
        // query can get now, since no exhaust $filter is ever sent).
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res);
      // ALL 4 docs come back -- nothing is dropped -- but the exhaust-typed ones (status,
      // compaction-digest) sort after the genuine ones (decision, fact). The within-group order
      // here reflects the (default-on) authority re-rank: decision (1.5x) and fact (1.2x) both
      // outrank compaction-digest (1.0x, unmatched by the authority table) and status (0.85x).
      assert.equal(res!.matches.length, 4, 'exhaust hits are demoted, never dropped');
      assert.deepEqual(
        res!.matches.map((m) => m.type),
        ['decision', 'fact', 'compaction-digest', 'status'],
        'both non-exhaust hits sort ahead of both exhaust hits',
      );
    },
  );
});

test('hybridSearch: includeOps=false still respects `top` -- exhaust only fills slots non-exhaust hits do not fill', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      // Only 2 of the 4 mocked docs are non-exhaust (decision, fact). Asking for top 2 must
      // return ONLY those two -- the exhaust hits must never crowd out a genuine hit that fits.
      const top2 = await hybridSearch('memory-exec', 'query', 2, { includeOps: false });
      assert.ok(top2);
      assert.deepEqual(top2!.matches.map((m) => m.type), ['decision', 'fact']);

      // Asking for top 3 (more genuine hits than exist) backfills with the highest-ranked exhaust
      // hit rather than returning a truncated 2-hit answer.
      const top3 = await hybridSearch('memory-exec', 'query', 3, { includeOps: false });
      assert.ok(top3);
      assert.deepEqual(top3!.matches.map((m) => m.type), ['decision', 'fact', 'compaction-digest']);
    },
  );
});

// --- behavior 2: include_ops=true skips the exclusion and returns operational exhaust ---

test('hybridSearch: includeOps=true sends NO filter and returns exhaust-typed docs unfiltered', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: true });
      assert.ok(res);
      assert.equal(capturedBody?.filter, undefined, 'no filter should be sent when includeOps is true');
      assert.equal(res!.matches.length, 4, 'every doc (including status/compaction-digest) must come back');
    },
  );
});

test('hybridSearch: omitting opts entirely (e.g. kb_search_privileged\'s call site) is unchanged — no filter, nothing dropped', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      // Exactly the 3-arg call kb_search_privileged makes today — no 4th opts argument at all.
      const res = await hybridSearch('legal-personal', 'query', 10);
      assert.ok(res);
      assert.equal(capturedBody?.filter, undefined);
      assert.equal(res!.matches.length, 4, 'a caller that never asked for room hygiene keeps its old behavior byte-for-byte');
    },
  );
});

// --- behavior 3: FAIL-OPEN — a filter problem never breaks search ---

test('FAIL-OPEN: a 400 on the semantic attempt falls back to a plain query and still returns results, demoted not dropped', async () => {
  let searchCallCount = 0;
  const sentBodies: Array<Record<string, unknown>> = [];
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        searchCallCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        sentBodies.push(body);
        if (searchCallCount === 1) {
          // Simulates the semantic ranker being unsupported on this SKU (a room's schema mismatch
          // no longer causes this since no exhaust $filter is ever sent by default any more). 400.
          return new Response(JSON.stringify({ error: { message: 'unsupported query type' } }), { status: 400 });
        }
        // The fallback attempt: plain simple query, no semantic -- still returns the full mix (with
        // `type` present, so the demotion re-rank below has something to prove).
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res, 'must not throw / return null on a semantic-layer 400');
      assert.equal(searchCallCount, 2, 'exactly one retry: the enriched attempt + the plain fallback');
      assert.equal(sentBodies[0]?.filter, undefined, 'no exhaust filter is sent by default, even on the primary attempt');
      assert.equal(sentBodies[1]?.queryType, 'simple', 'the fallback body must be the plain simple query');
      // The demotion re-rank still runs on the fallback's results: all 4 docs come back, exhaust
      // sorted after genuine hits -- never dropped, per the file header's demote-not-delete design.
      assert.deepEqual(
        res!.matches.map((m) => m.type),
        ['decision', 'fact', 'compaction-digest', 'status'],
      );
    },
  );
});

test('FAIL-OPEN: a THROWN error on the filtered attempt falls back to the plain query rather than propagating', async () => {
  // NOTE on call count: fetchWithBudget (src/util/fetch-budget.ts) wraps every raw fetch with its
  // OWN one-retry-on-thrown-error budget, so a single logical "filtered doSearch() call" that keeps
  // throwing costs it 2 raw fetch attempts before fetchWithBudget itself gives up and re-throws to
  // hybridSearch — only THEN does hybridSearch's own try/catch below kick in and try the filter-free
  // fallback (1 more raw fetch attempt). So: 2 throws (exhausting fetchWithBudget's retry) + 1 success.
  let searchCallCount = 0;
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        searchCallCount++;
        if (searchCallCount <= 2) throw new TypeError('network blip on the filtered attempt');
        return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res, 'a thrown error on the filtered attempt must not propagate as a search outage');
      assert.equal(searchCallCount, 3, '2 throws to exhaust fetchWithBudget\'s own retry, then 1 successful fallback attempt');
      assert.equal(res!.matches.length, 1);
      assert.equal(res!.matches[0]?.type, 'fact');
    },
  );
});

test('FAIL-OPEN: a room with no `type` field at all (doc-indexer profile room) is untouched by the backstop', async () => {
  // commons-company-journal / legal-company / finance-cfo-source-docs style docs: no `type` field.
  const TYPELESS_DOCS = [
    { id: 'a', category: 'contract', text: 'a legal doc chunk', '@search.rerankerScore': 2.5 },
    { id: 'b', category: 'invoice', text: 'a finance doc chunk', '@search.rerankerScore': 2.4 },
  ];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: TYPELESS_DOCS }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('commons-company-journal', 'query', 10, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 2, 'no doc has a `type` field, so nothing looks like exhaust and nothing is dropped');
    },
  );
});

// THE 2026-07-20 INCIDENT, ENCODED AS A TEST. The S1 free semantic quota exhausted and every
// semantic query returned 402 — and because fail-open only covered 400, the whole brain went
// dark fleet-wide. The contract is now: ANY non-2xx on the enriched attempt gets ONE plain
// keyword fallback (no semantic/metered dependency); only a fallback failure throws.
test('FAIL-OPEN WIDENED: a 402 (semantic quota exhausted) on the enriched attempt degrades to the plain query instead of going dark', async () => {
  let searchCallCount = 0;
  const sentBodies: Array<Record<string, unknown>> = [];
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        searchCallCount++;
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        sentBodies.push(body);
        if (searchCallCount === 1) {
          return new Response(JSON.stringify({ error: { message: 'Semantic search quota exceeded' } }), { status: 402 });
        }
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res, 'a metered-dependency 402 must degrade, never throw');
      assert.equal(searchCallCount, 2, 'exactly one retry: the enriched attempt + the plain fallback');
      assert.equal(sentBodies[1]?.queryType, 'simple', 'the fallback body must be the plain simple query');
      assert.ok(res!.matches.length > 0, 'degraded results still flow');
    },
  );
});

test('a TRUE outage (fallback also non-2xx) still throws — fail-open degrades the enrichment layer, it does not hide a dead service', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response('internal error', { status: 500 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await assert.rejects(() => hybridSearch('memory-exec', 'query', 10, { includeOps: false }), /search 500/);
    },
  );
});

// --- behavior 4: CHUNKED doc rooms (Phase-3 S1) — text_vector field, chunk->parent dedup, cite path ---

const CHUNKED_DOCS = [
  { chunk_id: 'p1#0', parent_id: 'p1', path: 'legal/contractA.pdf', chunk: 'chunk zero of contract A', '@search.rerankerScore': 3.5 },
  { chunk_id: 'p1#1', parent_id: 'p1', path: 'legal/contractA.pdf', chunk: 'chunk one of contract A', '@search.rerankerScore': 3.9 },
  { chunk_id: 'p2#0', parent_id: 'p2', path: 'legal/contractB.pdf', chunk: 'chunk zero of contract B', '@search.rerankerScore': 3.2 },
];

test('hybridSearch (chunked room): dedups chunks to one hit per parent, cites the parent path, picks the best-scoring chunk', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: CHUNKED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-company', 'contract', 8, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 2, "p1's two chunks collapse to one hit -> two distinct parents");
      assert.deepEqual(res!.matches.map((m) => m.id).sort(), ['p1', 'p2'], 'hits are cited by parent_id, not chunk_id');
      const p1 = res!.matches.find((m) => m.id === 'p1')!;
      assert.equal(p1.path, 'legal/contractA.pdf', 'parent path is carried for citation');
      assert.equal(p1.text, 'chunk one of contract A', 'the higher-scored chunk (p1#1) represents the parent');
      const vq = (capturedBody?.vectorQueries as Array<Record<string, unknown>>)[0];
      assert.equal(vq.fields, 'text_vector', 'chunked rooms query text_vector, never contentVector');
      assert.equal(capturedBody?.filter, undefined, 'no type filter on a chunked room (it has no type field)');
      assert.equal(capturedBody?.select, 'chunk_id,parent_id,title,path,chunk', 'lean select omits the 3072-float vector');
    },
  );
});

test('hybridSearch (chunked room): over-fetches (top*3, capped at 50) so dedup can still return `top` parents', async () => {
  let capturedTop: unknown;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        const b = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        capturedTop = b.top;
        return new Response(JSON.stringify({ value: CHUNKED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await hybridSearch('finance-cfo-source-docs', 'q', 8);
      assert.equal(capturedTop, 24, 'chunked over-fetch = top*3');
      await hybridSearch('commons-company-journal', 'q', 20);
      assert.equal(capturedTop, 50, 'capped at 50');
    },
  );
});

test('FAIL-OPEN (chunked room): a 400 degrades to a BARE keyword query with NO select (regression guard for the fallback-select bug)', async () => {
  let searchCallCount = 0;
  const sentBodies: Array<Record<string, unknown>> = [];
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        searchCallCount++;
        sentBodies.push(init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {});
        // Simulate a room not yet cut over to the chunked schema: text_vector/select fields absent -> 400.
        if (searchCallCount === 1) return new Response(JSON.stringify({ error: { message: 'unknown field text_vector' } }), { status: 400 });
        return new Response(JSON.stringify({ value: CHUNKED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-company', 'contract', 8, { includeOps: false });
      assert.ok(res, 'a chunked-room 400 must degrade to keyword, never throw');
      assert.equal(searchCallCount, 2, 'primary + one keyword fallback');
      assert.equal(sentBodies[1]?.select, undefined, 'the fallback must NOT repeat the select (else it 400s again -> hard throw)');
      assert.equal(sentBodies[1]?.vectorQueries, undefined, 'the fallback is a bare keyword query');
      assert.equal(sentBodies[1]?.queryType, 'simple');
      assert.equal(res!.matches.length, 2, 'dedup still collapses the fallback chunks to their parents');
    },
  );
});

// --- behavior 4b (2026-08-04, CLO field report): soft-deleted (_TRASH/) hits are suppressed, and
// byte-identical content under DIFFERENT parents (cross-prefix duplication) is collapsed with a
// `variants` field on the survivor. ---

test('hybridSearch (chunked room): a hit whose path is under _TRASH/ is suppressed entirely, even if it would have won its parent group', async () => {
  const DOCS_WITH_TRASH = [
    // The higher-scored chunk for parent p1 is the SOFT-DELETED one; the lower-scored survives.
    { chunk_id: 'p1#0', parent_id: 'p1', path: '_TRASH/legal/contractA.pdf', chunk: 'trashed copy', '@search.rerankerScore': 9.9 },
    { chunk_id: 'p1#1', parent_id: 'p1', path: 'legal/contractA.pdf', chunk: 'live copy', '@search.rerankerScore': 3.0 },
  ];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: DOCS_WITH_TRASH }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-personal', 'contract', 8, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 1, 'the _TRASH/ chunk must never surface as its own hit, and must never win the parent-group contest');
      assert.equal(res!.matches[0]!.path, 'legal/contractA.pdf');
      assert.equal(res!.matches[0]!.text, 'live copy');
    },
  );
});

test('hybridSearch (chunked room): a parent whose ONLY chunk is _TRASH/ produces no hit at all (not an empty/broken one)', async () => {
  const ONLY_TRASHED = [{ chunk_id: 'p9#0', parent_id: 'p9', path: '_TRASH/legal/gone.pdf', chunk: 'gone', '@search.rerankerScore': 5.0 }];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: ONLY_TRASHED }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-personal', 'gone', 8, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 0);
    },
  );
});

const LONG_TEXT_A = 'This letter concerns the finding and order after hearing entered by the court on the divorce matter.';

test('hybridSearch (chunked room): byte-identical content under TWO DIFFERENT parents collapses to one hit with a variants field, shallowest path wins', async () => {
  const CROSS_PREFIX_DUPES = [
    { chunk_id: 'd1#0', parent_id: 'd1', path: '_SUMMARY/clo-outgoing/01-Divorce/letter.md', chunk: LONG_TEXT_A, '@search.rerankerScore': 2.8471813201904297 },
    { chunk_id: 'd2#0', parent_id: 'd2', path: '_SUMMARY/divorce/letter.md', chunk: LONG_TEXT_A, '@search.rerankerScore': 2.8471813201904297 },
    { chunk_id: 'd3#0', parent_id: 'd3', path: 'legal/unrelated-contract.pdf', chunk: 'a completely different, unrelated document body long enough to pass the threshold', '@search.rerankerScore': 1.0 },
  ];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: CROSS_PREFIX_DUPES }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-personal', 'letter', 10, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 2, 'the two byte-identical duplicates collapse to ONE hit; the unrelated doc is untouched');
      const survivor = res!.matches.find((m) => m.text === LONG_TEXT_A)!;
      assert.ok(survivor, 'the duplicate-content hit must still be present, exactly once');
      assert.equal(survivor.path, '_SUMMARY/divorce/letter.md', 'shallowest path (fewer path segments) wins as canonical');
      assert.deepEqual(survivor.variants, ['_SUMMARY/clo-outgoing/01-Divorce/letter.md'], 'the non-canonical duplicate is recorded, not silently dropped');
      const unrelated = res!.matches.find((m) => m.path === 'legal/unrelated-contract.pdf')!;
      assert.ok(unrelated);
      assert.equal(unrelated.variants, undefined, 'a hit with no collapsed duplicate must never carry a variants key');
    },
  );
});

test('hybridSearch (chunked room): matching TEXT but a DIFFERENT score does NOT merge -- guards against shared-boilerplate false merges (PR #191 review)', async () => {
  // Two DIFFERENT real pleadings that happen to share the exact same boilerplate opening chunk as
  // their highest-scoring chunk (a realistic case: standard caption/header language). If text alone
  // were the grouping key, one of these would vanish from the results and get silently relabeled a
  // "variant" of the other -- exactly the false-merge risk the score+text combined key exists to
  // prevent. Distinct scores here (relevance is a function of each PARENT's full embedding, not just
  // this one shared chunk) must keep them as two separate hits.
  const SHARED_BOILERPLATE = 'IN THE SUPERIOR COURT OF THE STATE OF CALIFORNIA, COUNTY OF PLACER, FAMILY DIVISION';
  const SHARED_CHUNK_DOCS = [
    { chunk_id: 'f1#0', parent_id: 'f1', path: 'clo-outgoing/02-Civil/motion-to-compel.pdf', chunk: SHARED_BOILERPLATE, '@search.rerankerScore': 3.14159265358979 },
    { chunk_id: 'f2#0', parent_id: 'f2', path: 'clo-outgoing/01-Divorce/response-to-motion.pdf', chunk: SHARED_BOILERPLATE, '@search.rerankerScore': 2.71828182845904 },
  ];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: SHARED_CHUNK_DOCS }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-personal', 'court', 10, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 2, 'different documents sharing one boilerplate chunk must NEVER collapse into one hit');
      assert.ok(res!.matches.every((m) => m.variants === undefined), 'neither hit should be mislabeled as a variant of the other');
    },
  );
});

test('hybridSearch (chunked room): short/empty-text hits are NEVER merged with each other just for lacking distinguishing content', async () => {
  const SHORT_TEXT_DOCS = [
    { chunk_id: 'e1#0', parent_id: 'e1', path: 'legal/a.pdf', chunk: 'ok', '@search.rerankerScore': 2.0 },
    { chunk_id: 'e2#0', parent_id: 'e2', path: 'legal/b.pdf', chunk: 'ok', '@search.rerankerScore': 1.9 },
  ];
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: SHORT_TEXT_DOCS }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('legal-personal', 'ok', 10, { includeOps: false });
      assert.ok(res);
      assert.equal(res!.matches.length, 2, 'two genuinely different (unrelated) documents that happen to share short text must stay separate');
    },
  );
});

test('hybridSearch (flat room): still uses contentVector, no select, exact `top` — byte-identical to before', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      // Default (re-rank ON): flat memory rooms OVER-FETCH so the authority re-rank has a candidate
      // pool (min(30, top*3) = 18 for top=6). contentVector + no-select are unchanged.
      await hybridSearch('memory-exec', 'q', 6, { includeOps: true });
      const vq = (capturedBody?.vectorQueries as Array<Record<string, unknown>>)[0];
      assert.equal(vq.fields, 'contentVector', 'flat rooms keep contentVector');
      assert.equal(capturedBody?.select, undefined, 'flat rooms send no select');
      assert.equal(capturedBody?.top, 18, 'flat rooms over-fetch (top*3, capped 30) for the re-rank pool');
      // (The kill-switch OFF path — fetch exactly `top`, byte-identical order — is unit-tested in
      // authority-rerank.test.ts; loadEnv() caches, so it cannot be flipped mid-process here.)
    },
  );
});

// --- behavior 5: opts.filter, a raw $filter override (added for incident-match's pitfall/correction-only query) ---

test('hybridSearch: opts.filter is sent verbatim, and disables the room-hygiene demotion re-rank entirely', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      // opts.filter is a precise, caller-authored slice (e.g. incident-match's pitfall/
      // correction-only query): it is sent verbatim, and it is the ONLY filter this function ever
      // sends now (the default demote-not-delete path never builds its own).
      const res = await hybridSearch('memory-exec', 'query', 5, {
        includeOps: false,
        filter: "type eq 'pitfall' or type eq 'correction'",
      });
      assert.ok(res);
      assert.equal(capturedBody?.filter, "type eq 'pitfall' or type eq 'correction'");
    },
  );
});

test('hybridSearch: opts.filter is IGNORED for chunked rooms (no `type` field to filter on)', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withStubbedFetch(
    (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      await hybridSearch('legal-company', 'query', 5, { filter: "type eq 'pitfall'" });
      assert.equal(capturedBody?.filter, undefined, 'chunked rooms never send a type filter, even an explicit override');
    },
  );
});

// ==================================================================================================
// SHADOW EVAL (Wave 7 item 7.2, src/safety/shadow-eval.ts). hybridSearch's fire-and-forget,
// sampled, candidate-variant re-run. SHADOW_EVAL_* are read FRESH per call (never part of the
// cached loadEnv() schema, see config/env.ts's file-header comment), so they are safe to flip
// between tests within this one file/process, unlike AZURE_SEARCH_*/FOUNDRY_* above. COSMOS_ENDPOINT
// is never set anywhere in this file, so captureShadowComparison's Cosmos write is always a
// fail-open no-op here. These tests only need to prove the ORCHESTRATION contract, not the
// capture's own persistence (that is shadow-eval.test.ts's job).
// ==================================================================================================

function clearShadowEnv(): void {
  delete process.env.SHADOW_EVAL_MODE;
  delete process.env.SHADOW_EVAL_SAMPLE_RATE;
  delete process.env.SHADOW_EVAL_STRATEGY;
}

test('shadow eval OFF (default, unset): hybridSearch makes exactly one embed + one search call, no extra network activity at all', async () => {
  clearShadowEnv();
  let fetchCount = 0;
  await withStubbedFetch(
    (async (url: string | URL) => {
      fetchCount++;
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [MIXED_DOCS[0], MIXED_DOCS[2]] }), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'ASC key id', 10, { includeOps: false });
      assert.ok(res);
      // Give any accidental fire-and-forget work a moment to have started, if it were going to.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fetchCount, 2, 'SHADOW_EVAL_MODE unset must mean zero extra calls: 1 embed + 1 search, exactly as before this feature existed');
    },
  );
});

test('shadow eval ON but SHADOW_EVAL_SAMPLE_RATE=0: still exactly one embed + one search call, "on" alone does not force sampling', async () => {
  process.env.SHADOW_EVAL_MODE = 'on';
  process.env.SHADOW_EVAL_SAMPLE_RATE = '0';
  let fetchCount = 0;
  try {
    await withStubbedFetch(
      (async (url: string | URL) => {
        fetchCount++;
        const u = String(url);
        if (isEmbeddingsUrl(u)) return embeddingsOk();
        if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
        throw new Error(`unexpected fetch to ${u}`);
      }) as typeof fetch,
      async () => {
        const res = await hybridSearch('memory-exec', 'ASC key id', 10, { includeOps: false });
        assert.ok(res);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(fetchCount, 2, 'a sample rate of 0 must never trigger the shadow branch');
      },
    );
  } finally {
    clearShadowEnv();
  }
});

test('shadow eval ON + rate=1 against a RING-GATED index (kb_search_privileged\'s seam): the shadow re-run never even RUNS, no extra network call, cross-ring gate', async () => {
  // Ring-gated: the comparison record's destination (memory-exec, an OPEN index) would otherwise be
  // a MORE PERMISSIVE destination than the finance/legal room this query is actually against. See
  // safety/shadow-eval.ts's isRingGatedIndexName / RING_GATED_INDEX_NAMES.
  process.env.SHADOW_EVAL_MODE = 'on';
  process.env.SHADOW_EVAL_SAMPLE_RATE = '1';
  let fetchCount = 0;
  try {
    await withStubbedFetch(
      (async (url: string | URL) => {
        fetchCount++;
        const u = String(url);
        if (isEmbeddingsUrl(u)) return embeddingsOk();
        if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
        throw new Error(`unexpected fetch to ${u}`);
      }) as typeof fetch,
      async () => {
        const res = await hybridSearch('finance-cfo-memory', 'burn rate before the public filing', 10, { includeOps: false });
        assert.ok(res, 'the LIVE call itself must still succeed normally, only the shadow branch is gated');
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(fetchCount, 2, 'a ring-gated index must skip the shadow branch entirely even at sample rate 1: exactly 1 embed + 1 search, no second round trip');
      },
    );
  } finally {
    clearShadowEnv();
  }
});

test('shadow eval ON + sampled ALWAYS: the caller receives the LIVE path result UNCHANGED, even though the sampled strategy would clearly rank differently', async () => {
  // Deliberately scored so relevance dominates the authority re-rank (mirrors authority-rerank.ts's
  // own "a strongly-more-relevant hit still wins" design): the exhaust-typed 'status' doc has a much
  // higher raw score than the genuine 'fact' doc, so status still ranks ABOVE fact after the
  // (default-on) authority re-rank -- demote-not-delete's own client-side reorder is the ONLY thing
  // that can still move it after fact. With includeOps:false (the live opts here) that reorder DOES
  // happen; with includeOps:true (the 'demote-off' shadow strategy) it deliberately does not. So the
  // two settings provably diverge, which is exactly what makes this a meaningful "never leaks the
  // shadow's answer" proof rather than a coincidental match.
  const DIVERGENT_DOCS = [
    { id: 'x1', type: 'status', text: 'a high-score status row', '@search.rerankerScore': 100 },
    { id: 'x2', type: 'fact', text: 'a low-score fact row', '@search.rerankerScore': 1 },
  ];
  const stub = (async (url: string | URL) => {
    const u = String(url);
    if (isEmbeddingsUrl(u)) return embeddingsOk();
    if (isSearchUrl(u)) return new Response(JSON.stringify({ value: DIVERGENT_DOCS }), { status: 200 });
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;

  clearShadowEnv();
  const baseline = await withStubbedFetch(stub, () => hybridSearch('memory-exec', 'q', 10, { includeOps: false }));
  assert.ok(baseline);
  assert.deepEqual(
    baseline!.matches.map((m) => m.type),
    ['fact', 'status'],
    'sanity check on the fixture: WITHOUT shadow eval, demotion already reorders status after fact',
  );

  let fetchCount = 0;
  process.env.SHADOW_EVAL_MODE = 'on';
  process.env.SHADOW_EVAL_SAMPLE_RATE = '1';
  process.env.SHADOW_EVAL_STRATEGY = 'demote-off';
  let sampled: Awaited<ReturnType<typeof hybridSearch>>;
  try {
    sampled = await withStubbedFetch(
      (async (url: string | URL) => {
        fetchCount++;
        return stub(url as string);
      }) as typeof fetch,
      async () => {
        const r = await hybridSearch('memory-exec', 'q', 10, { includeOps: false });
        // The shadow branch is fire-and-forget: hybridSearch above already resolved (proving it did
        // NOT wait on it), but its own embed+search round trip is very likely still mid-flight at
        // this exact point. Give it a moment to actually finish BEFORE withStubbedFetch's `finally`
        // restores the real (unstubbed) fetch, so the shadow branch's second call lands on OUR
        // counting stub rather than racing the restore.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return r;
      },
    );
  } finally {
    clearShadowEnv();
  }

  assert.ok(sampled);
  assert.deepEqual(
    sampled!.matches,
    baseline!.matches,
    'the caller-visible result must be byte-identical whether or not a shadow strategy that would rank differently ran',
  );
  assert.deepEqual(
    sampled!.matches.map((m) => m.type),
    ['fact', 'status'],
    'must still reflect the LIVE opts (includeOps:false), never the shadow strategy\'s includeOps:true',
  );
  // Proves the shadow branch genuinely executed a SECOND embed+search round trip (not just that the
  // live result happened to be unaffected because nothing ran): 2 calls for the live path, 2 more
  // for the sampled shadow path.
  assert.equal(fetchCount, 4, 'a sampled call runs BOTH the live path and one full shadow re-run');
});

test('shadow eval: fire-and-forget, hybridSearch resolves BEFORE the shadow branch\'s own network call even settles', async () => {
  let liveEmbedsSeen = 0;
  let shadowFetchStarted = false;
  let releaseShadowFetch: (() => void) | undefined;
  const shadowGate = new Promise<void>((resolve) => {
    releaseShadowFetch = resolve;
  });

  process.env.SHADOW_EVAL_MODE = 'on';
  process.env.SHADOW_EVAL_SAMPLE_RATE = '1';
  process.env.SHADOW_EVAL_STRATEGY = 'baseline';

  try {
    await withStubbedFetch(
      (async (url: string | URL) => {
        const u = String(url);
        if (isEmbeddingsUrl(u)) {
          liveEmbedsSeen++;
          if (liveEmbedsSeen === 1) return embeddingsOk(); // the LIVE path's embed: resolves fast
          // Every subsequent embeddings call belongs to the shadow branch: stall it until the test
          // explicitly releases it, so we can prove hybridSearch does not wait on it.
          shadowFetchStarted = true;
          await shadowGate;
          return embeddingsOk();
        }
        if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
        throw new Error(`unexpected fetch to ${u}`);
      }) as typeof fetch,
      async () => {
        const startedAt = Date.now();
        const res = await hybridSearch('memory-exec', 'q', 10, { includeOps: false });
        const elapsedMs = Date.now() - startedAt;
        assert.ok(res);
        assert.ok(
          elapsedMs < 500,
          `hybridSearch must return without waiting on the shadow branch (took ${elapsedMs}ms while the shadow fetch was deliberately held open)`,
        );
        assert.equal(shadowFetchStarted, true, 'the shadow branch must actually have been INITIATED (fire), just not awaited (forget)');
        // Clean up: release the stalled fetch and give its chain a moment to drain before this test
        // (and the fetch stub) goes out of scope.
        releaseShadowFetch?.();
        await new Promise((r) => setTimeout(r, 20));
      },
    );
  } finally {
    clearShadowEnv();
  }
});

test('shadow eval: an unrecognized SHADOW_EVAL_STRATEGY falls back to a harmless no-op "baseline" re-run rather than throwing or disabling shadow mode', async () => {
  process.env.SHADOW_EVAL_MODE = 'on';
  process.env.SHADOW_EVAL_SAMPLE_RATE = '1';
  process.env.SHADOW_EVAL_STRATEGY = 'not-a-real-strategy';
  let fetchCount = 0;
  try {
    await withStubbedFetch(
      (async (url: string | URL) => {
        fetchCount++;
        const u = String(url);
        if (isEmbeddingsUrl(u)) return embeddingsOk();
        if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [MIXED_DOCS[0]] }), { status: 200 });
        throw new Error(`unexpected fetch to ${u}`);
      }) as typeof fetch,
      async () => {
        const res = await hybridSearch('memory-exec', 'q', 10, { includeOps: false });
        assert.ok(res, 'an unknown strategy name must never make hybridSearch throw or return null');
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(fetchCount, 4, 'the shadow branch still runs (as the baseline fallback), it just does not override anything');
      },
    );
  } finally {
    clearShadowEnv();
  }
});
