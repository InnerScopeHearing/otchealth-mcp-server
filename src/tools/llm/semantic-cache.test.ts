import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLlmCache,
  writeLlmCache,
  cacheMode,
  cacheEligible,
  similarityThreshold,
  scopeFor,
  DEFAULT_SIMILARITY_THRESHOLD,
  NEVER_CACHE_LANE,
  type LlmCacheDeps,
  type LlmCacheEntry,
} from './semantic-cache.js';
import type { VectorMatch } from '../../agentstate/cosmos.js';

// Pure, no-network: every Cosmos/Foundry call is faked via the injectable deps bag, mirroring
// memory/hot-cache.test.ts (this repo's ESM build does not allow node:test's mock.method() to
// override another module's live named export).

const ENTRY: LlmCacheEntry = { output: 'cached answer', model: 'gpt-5.1', usage: { total_tokens: 42 } };

function makeDeps(overrides: Partial<LlmCacheDeps> = {}): LlmCacheDeps & {
  upsertCallCount: () => number;
  embedCallCount: () => number;
} {
  let upsertCalls = 0;
  let embedCalls = 0;
  const deps: LlmCacheDeps = {
    isCosmosConfigured: () => true,
    embed: async () => {
      embedCalls++;
      return [0.1, 0.2, 0.3];
    },
    vectorSearch: async () => [],
    upsert: async () => {
      upsertCalls++;
      return undefined;
    },
    ...overrides,
  };
  return { ...deps, upsertCallCount: () => upsertCalls, embedCallCount: () => embedCalls };
}

test('cacheMode: defaults to off, only "on" (case-insensitive) enables it', () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    delete process.env.LLM_CACHE_MODE;
    assert.equal(cacheMode(), 'off');
    process.env.LLM_CACHE_MODE = 'On';
    assert.equal(cacheMode(), 'on');
    process.env.LLM_CACHE_MODE = 'enforce'; // not a valid value for this mode
    assert.equal(cacheMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('similarityThreshold: defaults sanely and clamps out-of-range values', () => {
  const prior = process.env.LLM_CACHE_SIMILARITY_THRESHOLD;
  try {
    delete process.env.LLM_CACHE_SIMILARITY_THRESHOLD;
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
    process.env.LLM_CACHE_SIMILARITY_THRESHOLD = '0.8';
    assert.equal(similarityThreshold(), 0.8);
    process.env.LLM_CACHE_SIMILARITY_THRESHOLD = '5'; // out of range
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
    process.env.LLM_CACHE_SIMILARITY_THRESHOLD = 'not-a-number';
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_SIMILARITY_THRESHOLD;
    else process.env.LLM_CACHE_SIMILARITY_THRESHOLD = prior;
  }
});

test('scopeFor: bakes caller lane + task + tier into the partition key', () => {
  assert.equal(scopeFor('cfo', 'classify', 'standard'), 'llm:cfo:classify:standard');
  assert.equal(scopeFor('clo', 'extract', 'high'), 'llm:clo:extract:high');
});

test('cacheEligible: false when LLM_CACHE_MODE is off, even with Cosmos configured', () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'off';
    assert.equal(cacheEligible('cfo', { isCosmosConfigured: () => true }), false);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('cacheEligible: false for blank lane or the privilege-walled clo-personal lane, even with mode=on', () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    assert.equal(cacheEligible('', { isCosmosConfigured: () => true }), false);
    assert.equal(cacheEligible(NEVER_CACHE_LANE, { isCosmosConfigured: () => true }), false);
    assert.equal(cacheEligible('CLO-Personal', { isCosmosConfigured: () => true }), false, 'case-insensitive bypass');
    assert.equal(cacheEligible('cfo', { isCosmosConfigured: () => true }), true);
    assert.equal(cacheEligible('cfo', { isCosmosConfigured: () => false }), false, 'unconfigured Cosmos is never eligible');
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: mode=off never touches embed/vectorSearch and always misses', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'off';
    const deps = makeDeps();
    const out = await checkLlmCache('categorize this invoice', 'cfo', 'classify', 'standard', { deps });
    assert.equal(out.hit, false);
    assert.equal(deps.embedCallCount(), 0);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: mode=on, a HIGH-similarity match is a HIT and returns the cached entry', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    let vectorSearchScope = '';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk, _field, _vec, top) => {
        vectorSearchScope = pk;
        assert.equal(top, 1);
        const match: VectorMatch = {
          doc: { id: 'llmcache_1', cacheScope: pk, prompt: 'p', queryVector: [0.1, 0.2, 0.3], entry: ENTRY, ts: '', ttl: 604800 },
          similarity: 0.99,
        };
        return [match];
      },
    });

    const out = await checkLlmCache('categorize this invoice', 'cfo', 'classify', 'standard', { deps });

    assert.equal(out.hit, true);
    assert.deepEqual(out.entry, ENTRY);
    assert.equal(out.similarity, 0.99);
    assert.equal(vectorSearchScope, 'llm:cfo:classify:standard', 'lookup must be scoped to lane+task+tier');
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: a similarity below the threshold is a MISS, not a hit', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk) => [
        { doc: { id: 'x', cacheScope: pk, prompt: 'p', queryVector: [], entry: ENTRY, ts: '', ttl: 0 }, similarity: 0.5 },
      ],
    });

    const out = await checkLlmCache('some other clause lookup', 'clo', 'extract', 'high', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: FAIL-OPEN — an embed() throw is swallowed and reported as a miss', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps({
      embed: async () => {
        throw new Error('Foundry outage');
      },
    });
    const out = await checkLlmCache('anything', 'cfo', 'classify', 'standard', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: FAIL-OPEN — a vectorSearch() throw (Cosmos down) is swallowed and reported as a miss', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async () => {
        throw new Error('simulated Cosmos outage');
      },
    });
    const out = await checkLlmCache('anything', 'cfo', 'classify', 'standard', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('checkLlmCache: a malformed cache doc (no entry.output) is treated as a miss, not a crash', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk) => [
        { doc: { id: 'x', cacheScope: pk, prompt: 'p' }, similarity: 0.999 } as VectorMatch,
      ],
    });
    const out = await checkLlmCache('anything', 'cfo', 'classify', 'standard', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('writeLlmCache: mode=on writes an entry scoped by lane+task+tier with a query vector', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    let upsertArgs: { coll: string; pk: string; doc: Record<string, unknown> } | null = null;
    const deps = makeDeps({
      upsert: async (coll, pk, doc) => {
        upsertArgs = { coll, pk, doc };
        return undefined;
      },
    });

    await writeLlmCache('categorize this invoice', 'cfo', 'classify', 'standard', ENTRY, { deps });

    assert.ok(upsertArgs, 'upsert should have been invoked');
    assert.equal(upsertArgs!.coll, 'cache');
    assert.equal(upsertArgs!.pk, 'llm:cfo:classify:standard');
    assert.equal(upsertArgs!.doc['cacheScope'], 'llm:cfo:classify:standard');
    assert.deepEqual(upsertArgs!.doc['entry'], ENTRY);
    assert.ok(Array.isArray(upsertArgs!.doc['queryVector']) && (upsertArgs!.doc['queryVector'] as number[]).length > 0);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('writeLlmCache: FAIL-OPEN — a write failure is swallowed and never throws', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps({
      upsert: async () => {
        throw new Error('simulated Cosmos outage');
      },
    });
    await assert.doesNotReject(writeLlmCache('anything', 'cfo', 'classify', 'standard', ENTRY, { deps }));
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('writeLlmCache: mode=off never calls upsert', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'off';
    const deps = makeDeps();
    await writeLlmCache('anything', 'cfo', 'classify', 'standard', ENTRY, { deps });
    assert.equal(deps.upsertCallCount(), 0);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});

test('writeLlmCache: the clo-personal lane is never written to the cache, even with mode=on', async () => {
  const prior = process.env.LLM_CACHE_MODE;
  try {
    process.env.LLM_CACHE_MODE = 'on';
    const deps = makeDeps();
    await writeLlmCache('anything', NEVER_CACHE_LANE, 'classify', 'standard', ENTRY, { deps });
    assert.equal(deps.upsertCallCount(), 0);
  } finally {
    if (prior === undefined) delete process.env.LLM_CACHE_MODE;
    else process.env.LLM_CACHE_MODE = prior;
  }
});
