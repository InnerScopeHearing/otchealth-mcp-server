import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cachedAgenticRecall,
  CACHE_TTL_SECONDS,
  DEFAULT_SIMILARITY_THRESHOLD,
  NEVER_CACHE_LANE,
  type HotCacheDeps,
} from './hot-cache.js';
import type { AgenticRecallResult } from './agentic.js';
import type { VectorMatch } from '../agentstate/store.js';

// Pure, no-network: every store/embedding/agentic call is faked via cachedAgenticRecall's injectable
// deps bag. This repo's ESM build does not allow node:test's mock.method() to override another
// module's live named export (TypeError: Cannot redefine property), so dependency injection is the
// only viable seam for testing this read-through path without calling a live provider.

const LIVE_RESULT: AgenticRecallResult = {
  mode: 'agentic-hybrid',
  subQueries: ['q1'],
  results: [
    { id: '1', ts: '2026-07-01T00:00:00Z', type: 'fact', text: 'live result', tags: [], agent: 'cto', score: 1, sourceSubQuery: 'q1' },
  ],
};

function makeDeps(overrides: Partial<HotCacheDeps> & { recallCalls?: string[]; upsertCalls?: Array<{ coll: string; pk: string; doc: Record<string, unknown> }>; vectorSearchCalls?: number[] } = {}): HotCacheDeps & {
  recallCallCount: () => number;
  upsertCallCount: () => number;
} {
  let recallCalls = 0;
  let upsertCalls = 0;
  const deps: HotCacheDeps = {
    isStoreConfigured: () => true,
    nowMs: () => Date.parse('2026-10-01T00:00:00.000Z'),
    embed: async () => [0.1, 0.2, 0.3],
    vectorSearch: async () => [],
    upsert: async () => {
      upsertCalls++;
      return undefined;
    },
    recall: async () => {
      recallCalls++;
      return LIVE_RESULT;
    },
    ...overrides,
  };
  return {
    ...deps,
    recallCallCount: () => recallCalls,
    upsertCallCount: () => upsertCalls,
  };
}

test('cachedAgenticRecall: a HIT returns the cached result WITHOUT calling agenticRecall or vectorSearch again', async () => {
  const cachedResult: AgenticRecallResult = {
    mode: 'agentic-hybrid',
    subQueries: ['prior query'],
    results: [
      { id: '99', ts: '2026-06-30T00:00:00Z', type: 'decision', text: 'cached result', tags: [], agent: 'cto', score: 2, sourceSubQuery: 'prior query' },
    ],
  };
  let vectorSearchCalls = 0;
  const deps = makeDeps({
    vectorSearch: async (_coll, pk, _field, _vec, top) => {
      vectorSearchCalls++;
      assert.match(pk, /^agent:cto:recall:[a-f0-9]{64}$/, 'vector search must include caller and recall dimensions');
      assert.equal(top, 1);
      const match: VectorMatch = {
        doc: { id: 'cache_1', cacheScope: pk, query: 'hello', queryVector: [0.1, 0.2, 0.3], result: cachedResult, ts: '2026-09-30T00:00:00.000Z', ttl: 604800 },
        similarity: 0.99,
      };
      return [match];
    },
  });

  const out = await cachedAgenticRecall('hello', { scope: 'cto', deps });

  assert.equal(out.cacheHit, true);
  assert.equal(out.mode, 'cache-hit');
  assert.deepEqual(out.results, cachedResult.results);
  assert.equal(vectorSearchCalls, 1, 'vector search should run exactly once');
  assert.equal(deps.recallCallCount(), 0, 'a cache HIT must never call the underlying agenticRecall');
  assert.equal(deps.upsertCallCount(), 0, 'a cache HIT must never re-write the cache');
});

test('cachedAgenticRecall: caller, content filter, and effective result limit isolate hits without result leakage', async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const recallOptions: Array<{ agent?: string; top?: number }> = [];
  const deps = makeDeps({
    vectorSearch: async (_coll, pk) => {
      const doc = stored.get(pk);
      return doc ? [{ doc, similarity: 0.99 } as VectorMatch] : [];
    },
    upsert: async (_coll, pk, doc) => {
      stored.set(pk, doc);
    },
    recall: async (_query, opts) => {
      recallOptions.push(opts ?? {});
      const agent = opts?.agent ?? 'all';
      const top = opts?.top ?? 5;
      return {
        mode: 'agentic-hybrid',
        subQueries: ['synthetic'],
        results: [
          { id: `${agent}:${top}`, ts: '2026-09-30T00:00:00Z', type: 'fact', text: `${agent}:${top}`, tags: [], agent, score: 1, sourceSubQuery: 'synthetic' },
        ],
      };
    },
  });

  const commerce20 = await cachedAgenticRecall('same synthetic query', { scope: 'cto', agent: 'commerce', top: 20, deps });
  const commerce20Canonical = await cachedAgenticRecall('same synthetic query', { scope: 'cto', agent: 'commerce', top: 20, deps });
  const support20 = await cachedAgenticRecall('same synthetic query', { scope: 'cto', agent: 'support', top: 20, deps });
  const support40 = await cachedAgenticRecall('same synthetic query', { scope: 'cto', agent: 'support', top: 40, deps });
  const support40OtherCaller = await cachedAgenticRecall('same synthetic query', { scope: 'developer', agent: 'support', top: 40, deps });
  const allDefault = await cachedAgenticRecall('default synthetic query', { scope: 'cto', deps });
  const allExplicitDefault = await cachedAgenticRecall('default synthetic query', { scope: 'cto', agent: '', top: 5, deps });

  assert.equal(commerce20.cacheHit, false);
  assert.equal(commerce20.results[0]?.text, 'commerce:20');
  assert.equal(commerce20Canonical.cacheHit, true, 'same dimensions and caller should reuse the partition');
  assert.equal(commerce20Canonical.results[0]?.text, 'commerce:20');
  assert.equal(support20.cacheHit, false, 'a different content filter must not serve commerce results');
  assert.equal(support20.results[0]?.text, 'support:20');
  assert.equal(support40.cacheHit, false, 'a different result limit must not serve a top-20 result set');
  assert.equal(support40.results[0]?.text, 'support:40');
  assert.equal(support40OtherCaller.cacheHit, false, 'a different caller lane must remain isolated');
  assert.equal(support40OtherCaller.results[0]?.text, 'support:40');
  assert.equal(allDefault.cacheHit, false);
  assert.equal(allExplicitDefault.cacheHit, true, 'blank filter and omitted/default limit have equivalent behavior');
  assert.equal(allExplicitDefault.results[0]?.text, 'all:5');
  assert.deepEqual(recallOptions, [
    { agent: 'commerce', top: 20 },
    { agent: 'support', top: 20 },
    { agent: 'support', top: 40 },
    { agent: 'support', top: 40 },
    { agent: undefined, top: undefined },
  ]);
  assert.equal(CACHE_TTL_SECONDS, 604800);
  for (const doc of stored.values()) assert.equal(doc.ttl, CACHE_TTL_SECONDS);
});

test('cachedAgenticRecall: a similarity below the threshold is treated as a MISS, not a hit', async () => {
  const deps = makeDeps({
    vectorSearch: async (_coll, pk) => [
      { doc: { id: 'x', cacheScope: pk, query: 'q', queryVector: [], result: LIVE_RESULT, ts: '', ttl: 0 }, similarity: 0.5 },
    ],
  });

  const out = await cachedAgenticRecall('hello', { scope: 'cto', deps });

  assert.equal(out.cacheHit, false);
  assert.equal(deps.recallCallCount(), 1, 'below-threshold similarity must fall through to a live recall');
});

test('cachedAgenticRecall: expired or invalid cache timestamps and TTLs fall through to live recall', async () => {
  const nowMs = 2_000_000_000_000;
  const invalidMetadata = [
    { ts: new Date(nowMs - 2_000).toISOString(), ttl: 1, name: 'expired' },
    { ts: new Date(nowMs - 1_000).toISOString(), ttl: 1, name: 'expired at boundary' },
    { ts: 'not-a-timestamp', ttl: 60, name: 'malformed timestamp' },
    { ts: new Date(nowMs + 1_000).toISOString(), ttl: 60, name: 'future timestamp' },
    { ts: new Date(nowMs - 1_000).toISOString(), ttl: 0, name: 'zero TTL' },
    { ts: new Date(nowMs - 1_000).toISOString(), ttl: 604801, name: 'TTL above configured maximum' },
  ];

  for (const metadata of invalidMetadata) {
    const deps = makeDeps({
      nowMs: () => nowMs,
      vectorSearch: async (_coll, pk) => [
        {
          doc: {
            id: 'synthetic-cache-row', cacheScope: pk, query: 'synthetic query', queryVector: [0.1],
            result: { ...LIVE_RESULT, results: [{ ...LIVE_RESULT.results[0]!, text: `must-not-return-${metadata.name}` }] },
            ts: metadata.ts, ttl: metadata.ttl,
          },
          similarity: 0.99,
        } as VectorMatch,
      ],
    });

    const out = await cachedAgenticRecall('synthetic query', { scope: 'cto', deps });

    assert.equal(out.cacheHit, false, `${metadata.name} must not be served as a cache hit`);
    assert.equal(out.results[0]?.text, LIVE_RESULT.results[0]?.text, `${metadata.name} must fall through to fresh recall`);
    assert.equal(deps.recallCallCount(), 1, `${metadata.name} must invoke live recall`);
  }
});

test('cachedAgenticRecall: a MISS calls agenticRecall, then writes the result to the cache', async () => {
  let embedCalls = 0;
  let upsertCalls = 0;
  let upsertArgs: { coll: string; pk: string; doc: Record<string, unknown> } | null = null;
  let resolveUpsert!: () => void;
  const upsertDone = new Promise<void>((resolve) => {
    resolveUpsert = resolve;
  });

  const deps = makeDeps({
    embed: async () => {
      embedCalls++;
      return [0.4, 0.5, 0.6];
    },
    vectorSearch: async () => [], // no cache entry yet -> miss
    upsert: async (coll, pk, doc) => {
      upsertCalls++;
      upsertArgs = { coll, pk, doc };
      resolveUpsert();
      return undefined;
    },
  });

  const out = await cachedAgenticRecall('what is the deploy status', { scope: 'cto', deps });
  await upsertDone;

  assert.equal(out.cacheHit, false);
  assert.equal(out.mode, 'agentic-hybrid');
  assert.deepEqual(out.results, LIVE_RESULT.results);
  assert.equal(deps.recallCallCount(), 1, 'a MISS must call the underlying agenticRecall exactly once');
  assert.equal(upsertCalls, 1, 'a MISS must write the fresh result back to the cache exactly once');
  assert.ok(upsertArgs, 'upsert should have been invoked');
  assert.equal(upsertArgs!.coll, 'cache');
  assert.match(upsertArgs!.pk, /^agent:cto:recall:[a-f0-9]{64}$/, 'the write must include caller and recall dimensions');
  assert.equal(upsertArgs!.doc['query'], 'what is the deploy status');
  assert.equal(upsertArgs!.doc['cacheScope'], upsertArgs!.pk);
  assert.deepEqual(upsertArgs!.doc['result'], LIVE_RESULT);
  assert.ok(Array.isArray(upsertArgs!.doc['queryVector']) && (upsertArgs!.doc['queryVector'] as number[]).length > 0);
  assert.ok(embedCalls >= 1, 'embed should run to produce the query vector for lookup and/or the cache write');
});

test('cachedAgenticRecall: a cache-write failure is swallowed and never surfaces to the caller', async () => {
  const deps = makeDeps({
    vectorSearch: async () => [],
    upsert: async () => {
      throw new Error('simulated store outage');
    },
  });

  const out = await cachedAgenticRecall('anything', { scope: 'cto', deps });

  assert.equal(out.cacheHit, false);
  assert.deepEqual(out.results, LIVE_RESULT.results, 'the live recall result must still be returned even if the cache write throws');
});

test('cachedAgenticRecall: the privilege-walled clo-personal lane BYPASSES the cache entirely (never read, never written)', async () => {
  const deps = makeDeps();
  let vectorSearchCalls = 0;
  deps.vectorSearch = async () => {
    vectorSearchCalls++;
    return [];
  };

  const out = await cachedAgenticRecall('anything', { scope: NEVER_CACHE_LANE, deps });

  assert.equal(out.cacheHit, false);
  assert.equal(vectorSearchCalls, 0, 'clo-personal must never trigger a cache lookup');
  assert.equal(deps.recallCallCount(), 1, 'the underlying recall still runs normally for clo-personal');
  assert.equal(deps.upsertCallCount(), 0, 'clo-personal must never be written to the cache');
});

test('cachedAgenticRecall: the clo-personal bypass is case-insensitive and trims whitespace', async () => {
  for (const variant of ['CLO-Personal', '  clo-personal  ', 'Clo-Personal']) {
    const deps = makeDeps();
    const out = await cachedAgenticRecall('q', { scope: variant, deps });
    assert.equal(out.cacheHit, false);
    assert.equal(deps.upsertCallCount(), 0, `variant "${variant}" must still bypass the cache`);
  }
});

test('cachedAgenticRecall: an unconfigured selected store is a clean no-op passthrough (identical to calling agenticRecall directly)', async () => {
  let vectorSearchCalls = 0;
  let upsertCalls = 0;
  const deps = makeDeps({
    isStoreConfigured: () => false,
    vectorSearch: async () => {
      vectorSearchCalls++;
      return [];
    },
    upsert: async () => {
      upsertCalls++;
      return undefined;
    },
  });

  const out = await cachedAgenticRecall('hello', { scope: 'cto', deps });

  assert.equal(out.cacheHit, false);
  assert.equal(out.mode, 'agentic-hybrid');
  assert.deepEqual(out.results, LIVE_RESULT.results);
  assert.equal(vectorSearchCalls, 0, 'an unconfigured selected store must never attempt a vector search');
  assert.equal(upsertCalls, 0, 'an unconfigured selected store must never attempt a cache write');
  assert.equal(deps.recallCallCount(), 1, 'the caller should get exactly the live agenticRecall behavior');
});

test('cachedAgenticRecall: a blank/unset scope also skips the cache (nothing to partition it under)', async () => {
  const deps = makeDeps();
  let vectorSearchCalls = 0;
  deps.vectorSearch = async () => {
    vectorSearchCalls++;
    return [];
  };

  const out1 = await cachedAgenticRecall('hello', { deps }); // scope omitted entirely
  const out2 = await cachedAgenticRecall('hello', { scope: '', deps }); // scope explicitly blank

  assert.equal(out1.cacheHit, false);
  assert.equal(out2.cacheHit, false);
  assert.equal(vectorSearchCalls, 0);
  assert.equal(deps.upsertCallCount(), 0);
});

test('cachedAgenticRecall: an embed() failure during lookup falls through to a live recall (best-effort cache)', async () => {
  const deps = makeDeps({
    embed: async () => {
      throw new Error('Foundry embed transiently unavailable');
    },
  });

  const out = await cachedAgenticRecall('hello', { scope: 'cto', deps });

  assert.equal(out.cacheHit, false);
  assert.deepEqual(out.results, LIVE_RESULT.results);
  assert.equal(deps.recallCallCount(), 1, 'a broken embed must still fall through to the live recall path');
});

test('cachedAgenticRecall: the `agent` content filter is forwarded to agenticRecall unchanged, independent of `scope`', async () => {
  let forwardedAgent: string | undefined;
  const deps = makeDeps({
    recall: async (_q, opts) => {
      forwardedAgent = opts?.agent;
      return LIVE_RESULT;
    },
  });

  await cachedAgenticRecall('hello', { scope: 'cto', agent: 'commerce', deps });

  assert.equal(forwardedAgent, 'commerce', 'the content filter must pass through untouched even though the cache scope is a different lane (cto)');
});

test('DEFAULT_SIMILARITY_THRESHOLD is the documented 0.97 near-duplicate bar', () => {
  assert.equal(DEFAULT_SIMILARITY_THRESHOLD, 0.97);
});
