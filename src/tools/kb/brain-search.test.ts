import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars (searchConfigured()/foundryConfigured() go through loadEnv via
// azure/search.ts and azure/foundry.ts), then configure Azure AI Search so handleBrainSearch's real
// code paths (not the 'unconfigured' early return) run below. Mirrors src/memory/agentic.test.ts and
// src/azure/search.test.ts's preamble exactly. Foundry is deliberately left UNCONFIGURED here: the
// tests below only exercise the fast path and the deep-mode kill-switch (which must short-circuit
// BEFORE any Foundry call), so an unconfigured Foundry is itself part of proving those two paths
// never need it.
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
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-search.example.invalid';
process.env.AZURE_SEARCH_QUERY_KEY ||= 'test-search-key';

const { roomsFor, rrfFuse, fuseWithDirectCandidate, exactIdentifierCandidate, isOpaqueIdentifierQuery, canUseEntityLookup, buildEntityPromotion, OPEN_ROOMS, RING_ROOMS, handleBrainSearch, brainSearchInputShape } = await import('./brain-search.js');
const { activeEntityRows, matchEntity } = await import('../../memory/entity-lookup.js');
const { filterRetractedByAgent, __resetRetractionCache, __seedRetractionCacheForTests } = await import('../../memory/retractions.js');
const { z } = await import('zod');
type FixtureEntityRow = import('../../memory/entity-lookup.js').EntityRow;

// Pure network mocking via globalThis.fetch - the same seam src/memory/agentic.test.ts and
// src/azure/search.test.ts use, since this repo's ESM build does not let node:test's mock.method()
// redefine another module's live named export.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function isSearchUrl(url: string): boolean {
  return url.includes('/indexes/') && url.includes('/docs/search');
}

/** A minimal-but-complete fake ToolContext (only callerAgent is actually read by handleBrainSearch). */
function fakeCtx(callerAgent: string) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun: false, acknowledgeWarning: false, callerAgent };
}

function fixtureEntityLookup(rows: FixtureEntityRow[]) {
  return async (query: string, mode?: string, retractions?: ReadonlyMap<string, ReadonlySet<string>>) => {
    if ((mode || '').trim().toLowerCase() === 'off') return null;
    return matchEntity(query, activeEntityRows(rows, retractions));
  };
}

function primaryCloudEntityRows(): FixtureEntityRow[] {
  return [
    {
      id: '20260907-001', type: 'entity', ekey: 'otchealth_primary_cloud', evalue: 'legacy cloud',
      ts: '2026-09-01T12:00:00.000Z', agent: 'cto', source: 'verified record', tags: ['current-value'],
    },
    {
      id: '20260907-002', type: 'entity', ekey: 'otchealth_primary_cloud', evalue: 'AWS',
      ts: '2026-09-07T12:00:00.000Z', agent: 'cto', source: 'verified record', tags: ['current-value'],
      supersedes: '20260907-001',
    },
  ];
}

async function withEntityMode<T>(run: () => Promise<T>): Promise<T> {
  const prior = process.env.ENTITY_LOOKUP_MODE;
  process.env.ENTITY_LOOKUP_MODE = 'on';
  try { return await run(); }
  finally {
    if (prior === undefined) delete process.env.ENTITY_LOOKUP_MODE;
    else process.env.ENTITY_LOOKUP_MODE = prior;
  }
}

async function withRetrievalShield<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const prior = process.env.RETRIEVAL_SHIELD_MODE;
  process.env.RETRIEVAL_SHIELD_MODE = mode;
  try { return await run(); }
  finally {
    if (prior === undefined) delete process.env.RETRIEVAL_SHIELD_MODE;
    else process.env.RETRIEVAL_SHIELD_MODE = prior;
  }
}

// --- ring safety: federation must NEVER become a side door around a privilege boundary ---

test('a non-ring caller (cto) gets ONLY the open rooms - no finance, no legal', () => {
  const rooms = roomsFor('cto');
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
  for (const r of RING_ROOMS) assert.ok(!rooms.includes(r), `cto must not reach ${r}`);
});

test('direct exact hit survives top=1 fusion across many rooms, then remains retractable', () => {
  const perRoom = Array.from({ length: 8 }, (_, i) => ({
    room: `room-${i}`,
    hits: [{ score: 1, text: `rank-one-${i}`, id: `other__${i}` }],
  }));
  const direct = {
    score: 1,
    source: 'room-7',
    text: 'exact',
    id: 'cto__20260907-007',
    agent: 'cto',
  };
  const pool = fuseWithDirectCandidate(perRoom, 1, direct);
  assert.equal(pool[0]?.id, direct.id, 'candidate is retained before the normal top*3 trim');
  assert.equal(Number.isFinite(pool[0]?.score ?? Number.NaN), true,
    'public result scores must remain JSON-serializable numbers');

  const filtered = filterRetractedByAgent(pool, new Map([['cto', new Set(['20260907-007'])]]));
  assert.equal(filtered.kept.some((hit) => hit.id === direct.id), false,
    'retention runs before retraction filtering and cannot revive the exact row');
});

test('opaque literal witness survives federation rank loss but remains retractable', () => {
  const token = 'MXVEDTUKA2';
  const candidate = exactIdentifierCandidate(token, 'memory-exec', [
    { id: 'cto__semantic', text: 'semantic distractor' },
    { id: 'cto__literal', text: `literal ${token} evidence`, agent: 'cto', exactIdentifierMatch: true },
  ]);
  assert.ok(candidate);
  const ordinary = Array.from({ length: 8 }, (_, i) => ({ room: `room-${i}`, hits: [{ id: `other__${i}`, text: `rank-one-${i}` }] }));
  const pool = fuseWithDirectCandidate([...ordinary, { room: 'memory-exec', hits: [] }], 3, candidate);
  assert.equal(pool[0]?.id, 'cto__literal');
  const filtered = filterRetractedByAgent(pool, new Map([['cto', new Set(['literal'])]]));
  assert.equal(filtered.kept.some((hit) => hit.id === 'cto__literal'), false);
});

test('direct and opaque-ID preferred candidates retain citation locators through RRF', () => {
  const candidate = exactIdentifierCandidate('MXVEDTUKA2', 'memory-exec', [{
    id: 'cto__literal', text: 'synthetic evidence', agent: 'cto', exactIdentifierMatch: true,
    path: 'current/source.pdf', variants: ['archive/source.pdf'], type: 'decision', source_version: `sha256:${'a'.repeat(64)}`,
  }]);
  assert.ok(candidate);
  const pool = fuseWithDirectCandidate([{ room: 'memory-exec', hits: [] }], 1, candidate);
  assert.equal(pool[0]?.path, 'current/source.pdf');
  assert.deepEqual(pool[0]?.variants, ['archive/source.pdf']);
  assert.equal(pool[0]?.type, 'decision');
  assert.equal(pool[0]?.source_version, `sha256:${'a'.repeat(64)}`);
});

test('preferred version candidate does not discard a same-ID hit from another supplied version', () => {
  const a = `sha256:${'a'.repeat(64)}`;
  const b = `sha256:${'b'.repeat(64)}`;
  const pool = fuseWithDirectCandidate([{ room: 'commons-company-journal', hits: [
    { id: 'doc', text: 'version a', source_version: a },
    { id: 'doc', text: 'version b', source_version: b },
  ] }], 2, { score: 1, source: 'commons-company-journal', id: 'doc', text: 'version a', source_version: a });
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map((hit) => hit.source_version), [a, b]);
});

test('natural-language queries and unmarked identifier hits keep existing federation behavior', () => {
  assert.equal(isOpaqueIdentifierQuery('what is the current plan'), false);
  assert.equal(exactIdentifierCandidate('what is the current plan', 'memory-exec', [{ id: 'x', text: 'plan', exactIdentifierMatch: true }]), undefined);
  assert.equal(exactIdentifierCandidate('MXVEDTUKA2', 'memory-exec', [{ id: 'x', text: 'not a literal' }]), undefined);
});

test('an unauthenticated caller still gets the open rooms, never the ring', () => {
  const rooms = roomsFor(undefined);
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
});

test('an EXEC_RING caller (cfo) reaches the ring rooms too', () => {
  const rooms = roomsFor('cfo');
  assert.ok(rooms.includes('finance-cfo-source-docs'));
  assert.ok(rooms.includes('legal-company'));
  assert.ok(rooms.includes('memory-exec'));
});

test('REGRESSION (2026-07-21, least-privilege): coo and cro are removed from EXEC_RING, roomsFor() gives them ONLY the open rooms', () => {
  for (const caller of ['coo', 'cro']) {
    const rooms = roomsFor(caller);
    assert.deepEqual(rooms, [...OPEN_ROOMS], `caller=${caller}`);
    for (const r of RING_ROOMS) assert.ok(!rooms.includes(r), `${caller} must not reach ${r}`);
  }
});

test('a domain filter cannot escalate: cto asking for finance gets NO finance rooms', () => {
  assert.deepEqual(roomsFor('cto', 'finance'), []);
});

test('domain filter narrows correctly for a permitted caller', () => {
  // Option B (2026-07-16): cfo reaches company-legal but NOT the personal-legal rooms (clo-personal/exec only).
  assert.deepEqual(roomsFor('cfo', 'legal').sort(), ['legal-company']);
  assert.deepEqual(roomsFor('clo', 'legal').sort(), ['legal-company'],
    'corporate CLO search must never fan out to legal-personal fixtures');
  // the personal-legal lane DOES reach all three legal rooms
  assert.deepEqual(roomsFor('clo-personal', 'legal').sort(), ['legal-company', 'legal-personal', 'legal-personal-memory']);
  assert.deepEqual(roomsFor('cto', 'exec'), ['memory-exec']);
});

test('an unknown domain returns all permitted rooms rather than silently nothing', () => {
  assert.deepEqual(roomsFor('cto', 'not-a-domain'), [...OPEN_ROOMS]);
});


test('entity lookup obeys room narrowing and only runs when memory-exec is authorized', () => {
  assert.equal(canUseEntityLookup(['memory-exec', 'commons-company-journal']), true);
  assert.equal(canUseEntityLookup(['commons-company-journal']), false);
  assert.equal(canUseEntityLookup(['finance-cfo-source-docs']), false);
});

test('entity promotion exposes provenance metadata and a finite JSON-safe score', () => {
  const promotion = buildEntityPromotion({
    ekey: 'otchealth_brain_backend',
    evalue: 'current-value',
    ts: '2026-09-07T12:00:00.000Z',
    id: '20260907-001',
    source: 'verified witness',
    owner: 'cto',
    matchedBy: 'current-question',
  });
  assert.equal(Number.isFinite(promotion.match.score as number), true);
  assert.equal(promotion.match.agent, 'cto');
  assert.equal(promotion.match.matched_by, 'current-question');
  assert.equal(promotion.answer.source, 'verified witness');
  assert.equal(promotion.answer.owner, 'cto');
});

// --- RRF: rrfFuse's own behavior is now tested at its source, src/memory/rrf.test.ts. This just
// proves the re-export contract brain-search.ts's header promises (existing importers unaffected).

test('rrfFuse is re-exported from brain-search.js unchanged (backward-compat for existing importers)', () => {
  const fused = rrfFuse([{ room: 'a', hits: [{ text: 'x' }] }], 1);
  assert.equal(fused[0]?.text, 'x');
});

// --- mode:'fast' is unchanged (regression), and mode:'deep' respects the DEEP_RETRIEVAL_MODE
// kill-switch. handleBrainSearch is the extracted, directly-callable handler (see brain-search.ts).

test('the wire-level zod schema defaults `mode` to "fast" when the caller omits it entirely', () => {
  const parsed = z.object(brainSearchInputShape).parse({ query: 'ping' });
  assert.equal(parsed.mode, 'fast');
});

/** Stubs the AI Search docs/search endpoint with one canned hit; THROWS on anything else (in
 *  particular an embeddings or chat/completions call), so a test using this stub can assert
 *  "Foundry was never reached" simply by not failing with an "unexpected fetch" error. */
function mockSearchOnlyFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      return new Response(JSON.stringify({ value: [{ id: 'x1', text: 'a fast-mode hit', '@search.rerankerScore': 1.0 }] }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch to ${u} (this path must never reach an embeddings/chat endpoint)`);
  }) as typeof fetch;
}

test('fast and deep brain_search disclose incomplete retraction verification with fixed content-free warning', async () => {
  const priorMode = process.env.DEEP_RETRIEVAL_MODE;
  const warning = 'Retraction verification incomplete; one or more sources were unavailable.';
  try {
    __seedRetractionCacheForTests(new Map([['cto', new Set(['known-proof'])]]), false);
    await withStubbedFetch(mockSearchOnlyFetch(), async () => {
      const result = await handleBrainSearch({ query: 'q', mode: 'fast' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.equal(data.retraction_verification, 'complete');
      assert.equal(result.summary.includes(warning), false);
    });

    __seedRetractionCacheForTests(new Map([['cto', new Set(['known-proof'])]]), true);
    await withStubbedFetch(mockSearchOnlyFetch(), async () => {
      const result = await handleBrainSearch({ query: 'q', mode: 'fast' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.equal(data.retraction_verification, 'incomplete');
      assert.equal(result.summary.includes(warning), true);
    });

    process.env.DEEP_RETRIEVAL_MODE = 'on';
    __seedRetractionCacheForTests(new Map([['cto', new Set(['known-proof'])]]), true);
    await withStubbedFetch(mockSearchOnlyFetch(), async () => {
      const result = await handleBrainSearch({ query: 'q', mode: 'deep' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.equal(data.retraction_verification, 'incomplete');
      assert.equal(result.summary.includes(warning), true);
    });
  } finally {
    __resetRetractionCache();
    if (priorMode === undefined) delete process.env.DEEP_RETRIEVAL_MODE;
    else process.env.DEEP_RETRIEVAL_MODE = priorMode;
  }
});

test('handleBrainSearch mode:"fast" is a regression: same output shape as brain_search before deep mode existed', async () => {
  await withStubbedFetch(mockSearchOnlyFetch(), async () => {
    const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'fast' }, fakeCtx('cto'));
    const data = result.data as Record<string, unknown>;
    assert.equal(data.mode, 'federated-rrf');
    assert.ok(Array.isArray(data.matches));
    assert.equal(typeof data.count, 'number');
    assert.ok(Array.isArray(data.rooms_searched));
    assert.equal(data.include_ops, false);
    // FND-20260829-e454: the wall-clock-budget fields are ALSO deep-only -- fast mode's code path
    // (below the deep-mode `if`) is untouched by this fix and must never carry them.
    for (const deepOnlyField of ['answer', 'citations', 'sub_queries', 'rounds_used', 'partial', 'continuation', 'resumed', 'budget_skipped']) {
      assert.ok(!(deepOnlyField in data), `fast mode must NOT carry the deep-only field "${deepOnlyField}"`);
    }
  });
});

test('DEEP_RETRIEVAL_MODE=off: mode:"deep" behaves EXACTLY like mode:"fast" (kill-switch short-circuits before deepRetrieve/Foundry is ever reached)', async () => {
  const prior = process.env.DEEP_RETRIEVAL_MODE;
  process.env.DEEP_RETRIEVAL_MODE = 'off';
  try {
    await withStubbedFetch(mockSearchOnlyFetch(), async () => {
      // mockSearchOnlyFetch throws on anything that looks like an embeddings/chat call, so if the
      // kill-switch failed to short-circuit and deepRetrieve() (or its planning chat() call) ran
      // anyway, this test fails with "unexpected fetch" rather than silently passing.
      const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'deep' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.equal(data.mode, 'federated-rrf', 'kill-switched-off deep must produce the FAST mode marker, not deep-agentic');
      for (const deepOnlyField of ['answer', 'citations', 'sub_queries', 'rounds_used', 'partial', 'continuation', 'resumed', 'budget_skipped']) {
        assert.ok(!(deepOnlyField in data), `kill-switched-off deep must NOT carry the deep-only field "${deepOnlyField}"`);
      }
    });
  } finally {
    if (prior === undefined) delete process.env.DEEP_RETRIEVAL_MODE;
    else process.env.DEEP_RETRIEVAL_MODE = prior;
  }
});

test('DEEP_RETRIEVAL_MODE unset (default "on"): mode:"deep" takes the deep path (never the fast marker)', async () => {
  // This file's preamble deliberately leaves Foundry unconfigured, so ordinarily every LLM step
  // inside deepRetrieve would individually fail open (trivial plan, no refine, "unavailable"
  // synthesis note). But loadEnv() caches per-process, and node:test's isolation-per-file is an
  // assumption about the test RUNNER, not this repo's code -- so this stub tolerates an
  // embeddings/chat call too (unlike mockSearchOnlyFetch) rather than asserting on Foundry's
  // configured-ness, which is not what this test is actually about. What this test IS about: the
  // kill-switch being ON (or unset) really does route through deepRetrieve and produce a DEEP mode
  // marker + the deep-only fields, and deepRetrieve never throws either way. The mirror-image
  // "switch really is OFF" property is what the strict test above proves (it is a STRUCTURAL
  // guarantee there -- deepRetrieve is never even called -- so it does not share this concern).
  assert.equal(process.env.DEEP_RETRIEVAL_MODE, undefined, 'sanity: no leftover override from another test');
  const tolerantFetch = (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      return new Response(JSON.stringify({ value: [{ id: 'x1', text: 'a hit', '@search.rerankerScore': 1 }] }), { status: 200 });
    }
    if (u.includes('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    if (u.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"sub_queries":["q"]}' } }], model: 'test' }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
  await withStubbedFetch(tolerantFetch, async () => {
    const result = await handleBrainSearch({ query: 'what is the ASC key id', mode: 'deep' }, fakeCtx('cto'));
    const data = result.data as Record<string, unknown>;
    assert.ok(
      data.mode === 'deep-agentic' || data.mode === 'deep-fallback-fast',
      `expected a deep-mode marker, got "${String(data.mode)}"`,
    );
    assert.equal(typeof data.answer, 'string');
    assert.ok(Array.isArray(data.sub_queries));
    assert.equal(typeof data.rounds_used, 'number');
  });
});

test('deep mode promotes the current typed entity, removes its semantic duplicate, and cites the authoritative match', async () => {
  const rows = primaryCloudEntityRows();
  const currentId = '20260907-002';
  assert.deepEqual(activeEntityRows(rows).map((row: { id?: string }) => row.id), [currentId], 'the superseded entity row must be inactive');
  const searchDocId = `cto__${currentId}`;
  const fixtureFetch = (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) return new Response(JSON.stringify({ value: [{
      id: searchDocId, text: 'semantic duplicate of current entity', agent: 'cto', type: 'entity', '@search.rerankerScore': 1,
    }] }), { status: 200 });
    throw new Error(`unexpected provider request ${u}`);
  }) as typeof fetch;
  await withEntityMode(() => withRetrievalShield('off', () => withStubbedFetch(fixtureFetch, async () => {
    const result = await handleBrainSearch(
      { query: 'what is OTCHealth primary cloud now', mode: 'deep' }, fakeCtx('cto'),
      { lookupEntity: fixtureEntityLookup(rows), retractedIdsByAgent: async () => new Map() },
    );
    const data = result.data as Record<string, unknown>;
    const matches = data.matches as Array<Record<string, unknown>>;
    const entityAnswer = data.entity_answer as Record<string, unknown>;
    assert.equal(entityAnswer.value, 'AWS');
    assert.equal(entityAnswer.id, currentId);
    assert.equal(entityAnswer.source, 'verified record');
    assert.equal(entityAnswer.owner, 'cto');
    assert.equal(entityAnswer.matched_by, 'containment');
    assert.match(String(data.answer), /Current value: otchealth_primary_cloud = AWS \[1\]\./);
    assert.equal(matches[0]?.id, currentId);
    assert.equal(matches[0]?.authoritative, true);
    assert.equal(matches.length, 1, 'the prefixed deep search duplicate must be removed against its bare ledger ID');
    assert.equal(data.count, matches.length);
    assert.deepEqual(data.citations, [{ n: 1, source: 'memory-exec', id: currentId, type: 'entity' }]);
  })));
});

test('an enforce-mode retrieval shield block suppresses entity promotion and keeps the withheld answer', async () => {
  const deepRetrieveForTest = async () => ({
    mode: 'deep-agentic' as const,
    answer: 'Synthesis withheld by the retrieval shield.',
    citations: [],
    sub_queries: ['what is OTCHealth primary cloud now'],
    rounds_used: 1,
    hits: [],
    rooms_searched: ['memory-exec'],
    injection_screen: { attackDetected: true, mode: 'enforce' as const },
  });
  await withEntityMode(() => withRetrievalShield('enforce', async () => {
    const result = await handleBrainSearch(
      { query: 'what is OTCHealth primary cloud now', mode: 'deep' }, fakeCtx('cto'),
      {
        lookupEntity: fixtureEntityLookup(primaryCloudEntityRows()),
        retractedIdsByAgent: async () => new Map(),
        deepRetrieve: deepRetrieveForTest,
      },
    );
    const data = result.data as Record<string, unknown>;
    assert.equal(data.answer, 'Synthesis withheld by the retrieval shield.');
    assert.equal('entity_answer' in data, false);
    assert.equal((data.matches as Array<Record<string, unknown>>).some((hit) => hit.authoritative === true), false);
    assert.deepEqual(data.injection_screen, { attackDetected: true, mode: 'enforce' });
  }));
});

test('deep mode does not promote historical or foreign-scoped queries', async () => {
  const rows = primaryCloudEntityRows();
  await withEntityMode(() => withRetrievalShield('off', async () => {
    for (const query of ['what was the OTCHealth primary cloud', 'what is their OTCHealth primary cloud now']) {
      await withStubbedFetch(mockSearchOnlyFetch(), async () => {
        const result = await handleBrainSearch(
          { query, mode: 'deep' }, fakeCtx('cto'),
          { lookupEntity: fixtureEntityLookup(rows), retractedIdsByAgent: async () => new Map() },
        );
        const data = result.data as Record<string, unknown>;
        assert.equal('entity_answer' in data, false, `query must not be promoted: ${query}`);
        assert.equal((data.matches as Array<Record<string, unknown>>).some((hit) => hit.authoritative === true), false);
      });
    }
  }));
});

test('deep mode does not run entity promotion when the domain excludes memory-exec', async () => {
  let lookupCalls = 0;
  const rows = primaryCloudEntityRows();
  const lookupEntityForTest = async (
    query: string,
    mode?: string,
    retractions?: ReadonlyMap<string, ReadonlySet<string>>,
  ) => {
    lookupCalls++;
    return fixtureEntityLookup(rows)(query, mode, retractions);
  };
  await withEntityMode(() => withRetrievalShield('off', () => withStubbedFetch(mockSearchOnlyFetch(), async () => {
    const result = await handleBrainSearch(
      { query: 'what is OTCHealth primary cloud now', domain: 'commons', mode: 'deep' }, fakeCtx('cto'),
      { lookupEntity: lookupEntityForTest, retractedIdsByAgent: async () => new Map() },
    );
    const data = result.data as Record<string, unknown>;
    assert.equal(lookupCalls, 0);
    assert.equal('entity_answer' in data, false);
    assert.deepEqual(data.rooms_searched, ['commons-company-journal']);
  })));
});

test('deep continuation and partial budget retain original hits and citation indices', async () => {
  const originalNow = Date.now;
  let clock = originalNow();
  const currentId = '20260907-002';
  const rows = primaryCloudEntityRows();
  const stub = (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      const response = new Response(JSON.stringify({ value: [{ id: `cto__${currentId}`, text: 'current entity hit', agent: 'cto', '@search.rerankerScore': 1 }] }), { status: 200 });
      const readJson = response.json.bind(response);
      response.json = async () => { const body = await readJson(); clock += 30_001; return body; };
      return response;
    }
    throw new Error(`unexpected provider request ${u}`);
  }) as typeof fetch;
  await withEntityMode(() => withRetrievalShield('off', () => withStubbedFetch(stub, async () => {
    const priorBudget = process.env.DEEP_RETRIEVAL_BUDGET_MS;
    process.env.DEEP_RETRIEVAL_BUDGET_MS = '30000';
    Date.now = () => clock;
    try {
      const result = await handleBrainSearch(
        { query: 'what is OTCHealth primary cloud now', mode: 'deep', continuation: { rooms: ['memory-exec'], sub_queries: ['resume exact current cloud lookup'], rounds_used: 1 } },
        fakeCtx('cto'),
        { lookupEntity: fixtureEntityLookup(rows), retractedIdsByAgent: async () => new Map() },
      );
      const data = result.data as Record<string, unknown>;
      assert.equal(data.partial, true);
      assert.equal(data.resumed, true);
      assert.deepEqual(data.continuation, { rooms: ['memory-exec'], sub_queries: ['resume exact current cloud lookup'], rounds_used: 1 });
      assert.deepEqual(data.sub_queries, ['resume exact current cloud lookup']);
      assert.equal('entity_answer' in data, false);
      assert.equal(String(data.answer).includes('Current value:'), false, 'a partial status answer must not be rewritten as complete synthesis');
      const matches = data.matches as Array<Record<string, unknown>>;
      assert.equal(matches[0]?.id, `cto__${currentId}`);
      assert.equal((data.citations as Array<Record<string, unknown>>)[0]?.id, `cto__${currentId}`);
    } finally {
      Date.now = originalNow;
      if (priorBudget === undefined) delete process.env.DEEP_RETRIEVAL_BUDGET_MS;
      else process.env.DEEP_RETRIEVAL_BUDGET_MS = priorBudget;
    }
  })));
});

// --- FND-20260829-e454: handleBrainSearch wires input.continuation through to deepRetrieve, and
// surfaces partial/continuation/resumed/budget_skipped on the tool's own `data` object exactly
// like it already does for rooms_failed/retracted_dropped/injection_screen above. ---

// NOTE: this file's preamble deliberately leaves Foundry unconfigured (see its header comment),
// and loadEnv() caches per-process (the SAME constraint the pre-existing "DEEP_RETRIEVAL_MODE
// unset" test above documents) -- so, unlike deep-retrieval.test.ts's own budget/continuation
// tests, chat() can never actually be reached from THIS file, and planQuery/refineSubQueries/
// synthesizeAnswer stay on their fail-open trivial paths for every test here. The two tests below
// are scoped to what that constraint still lets them prove at the handler level: continuation
// surfacing/wiring and a real time-budget trip, using search-only real search calls (not chat).
// The full plan-skipping / re-synthesis behavior is already proven directly against deepRetrieve()
// in deep-retrieval.test.ts, where Foundry IS configured.

test('handleBrainSearch: input.continuation reaches deepRetrieve and its rooms/sub_queries are honored (not the trivial fail-open plan)', async () => {
  await withStubbedFetch(mockSearchOnlyFetch(), async () => {
    // A hand-crafted continuation whose sub_queries value could never arise from the trivial
    // fail-open plan (which always falls back to [originalQuery], i.e. ['q']) -- so seeing it
    // echoed back in the response proves the continuation was actually consumed, not ignored.
    const result = await handleBrainSearch(
      { query: 'q', mode: 'deep', continuation: { rooms: ['memory-exec'], sub_queries: ['a hand-crafted resumed sub-query'], rounds_used: 1 } },
      fakeCtx('cto'),
    );
    const data = result.data as Record<string, unknown>;
    assert.equal(data.mode, 'deep-agentic');
    assert.equal(data.resumed, true);
    assert.deepEqual(data.sub_queries, ['a hand-crafted resumed sub-query']);
    assert.deepEqual(data.rooms_searched, ['memory-exec']);
    assert.equal(data.partial, undefined, 'a generously-budgeted resume must not also come back partial');
  });
});

test('handleBrainSearch: exceeding the wall-clock budget surfaces partial:true + a continuation on the tool response (not just inside deepRetrieve)', async () => {
  const originalNow = Date.now;
  let clock = originalNow();
  let searchCalls = 0;
  const stub = (async (url: string | URL) => {
    const u = String(url);
    if (isSearchUrl(u)) {
      searchCalls++;
      const response = new Response(JSON.stringify({ value: [{ id: 'doc1', text: 'a hit', '@search.rerankerScore': 1 }] }), { status: 200 });
      const readJson = response.json.bind(response);
      response.json = async () => {
        const body = await readJson();
        // Move the clock only after the synthetic response body has been read. This proves
        // retention of an already-retrieved hit, independently of CI scheduling; a 1ms real
        // budget could correctly expire before retrieval starts under the stricter deadline.
        clock += 30_001;
        return body;
      };
      return response;
    }
    throw new Error(`unexpected fetch to ${u} (Foundry is unconfigured in this file -- no chat/embeddings call should ever be attempted)`);
  }) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const prior = process.env.DEEP_RETRIEVAL_BUDGET_MS;
    process.env.DEEP_RETRIEVAL_BUDGET_MS = '30000';
    Date.now = () => clock;
    try {
      const result = await handleBrainSearch({ query: 'q', mode: 'deep' }, fakeCtx('cto'));
      const data = result.data as Record<string, unknown>;
      assert.ok(searchCalls > 0, 'the fixture must actually retrieve before its clock expires');
      assert.equal(data.partial, true);
      assert.ok(data.continuation, 'the tool response must surface deepRetrieve\'s continuation, not just deepRetrieve\'s own return value');
      assert.equal(typeof data.answer, 'string');
      assert.ok((data.answer as string).length > 0);
      assert.ok(Array.isArray(data.matches) && (data.matches as unknown[]).length > 0, 'the already-retrieved hit is still returned in full');
    } finally {
      Date.now = originalNow;
      if (prior === undefined) delete process.env.DEEP_RETRIEVAL_BUDGET_MS;
      else process.env.DEEP_RETRIEVAL_BUDGET_MS = prior;
    }
  });
});
