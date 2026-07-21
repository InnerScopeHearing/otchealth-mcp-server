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

// --- behavior 1: exhaust excluded BY DEFAULT when the tool layer opts in (opts.includeOps=false) ---

test('hybridSearch: includeOps=false sends a server-side $filter excluding every exhaust type', async () => {
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
      assert.ok(typeof capturedBody?.filter === 'string', 'a filter clause must be sent');
      const filter = capturedBody!.filter as string;
      for (const t of ['status', 'episode', 'heartbeat', 'fleet-watch', 'digest', 'compaction-digest', 'compaction-note']) {
        assert.ok(filter.includes(`type ne '${t}'`), `filter should exclude "${t}": ${filter}`);
      }
    },
  );
});

test('hybridSearch: includeOps=false strips any exhaust-typed doc client-side too (post-filter backstop), even if the server returned one', async () => {
  await withStubbedFetch(
    (async (url: string | URL) => {
      const u = String(url);
      if (isEmbeddingsUrl(u)) return embeddingsOk();
      if (isSearchUrl(u)) {
        // Simulate a server that (for whatever reason) still returned a mix of exhaust + knowledge.
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res);
      const types = res!.matches.map((m) => m.type);
      assert.deepEqual(types.sort(), ['decision', 'fact']);
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

test('FAIL-OPEN: a 400 on the filtered/semantic attempt falls back to a plain filter-free query and still returns results', async () => {
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
          // Simulates: room has no filterable `type` field (doc-indexer profile room), OR the
          // semantic ranker is unsupported on this SKU. Either way: 400.
          return new Response(JSON.stringify({ error: { message: 'bad filter or unsupported query type' } }), { status: 400 });
        }
        // The fallback attempt: plain simple query, no filter, no semantic — still returns docs
        // (with `type` present, so the client-side backstop below has something to prove).
        return new Response(JSON.stringify({ value: MIXED_DOCS }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    async () => {
      const res = await hybridSearch('memory-exec', 'query', 10, { includeOps: false });
      assert.ok(res, 'must not throw / return null on a filter-related 400');
      assert.equal(searchCallCount, 2, 'exactly one retry: the filtered attempt + the filter-free fallback');
      assert.equal(sentBodies[1]?.filter, undefined, 'the fallback body must not carry the filter');
      assert.equal(sentBodies[1]?.queryType, 'simple', 'the fallback body must be the plain simple query');
      // The client-side post-filter backstop still holds even though the server-side filter was
      // dropped by the fail-open path — this is the "belt + braces" the search.ts header describes.
      const types = res!.matches.map((m) => m.type);
      assert.deepEqual(types.sort(), ['decision', 'fact']);
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

test('hybridSearch: opts.filter is sent verbatim, overriding the room-hygiene exhaust filter entirely', async () => {
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
      // includeOps:false would normally build the exhaust NOT-clause; opts.filter must win instead.
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
