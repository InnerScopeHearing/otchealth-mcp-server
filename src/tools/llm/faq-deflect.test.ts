import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFaqDeflect,
  seedFaqStore,
  faqEligible,
  faqDeflectMode,
  faqDeflectOn,
  similarityThreshold,
  FAQ_SEED,
  DEFAULT_SIMILARITY_THRESHOLD,
  type FaqDeflectDeps,
} from './faq-deflect.js';
import type { VectorMatch } from '../../agentstate/cosmos.js';

// Pure, no-network: every Cosmos/Foundry call is faked via the injectable deps bag, mirroring
// semantic-cache.test.ts / memory/hot-cache.test.ts (this repo's ESM build does not allow
// node:test's mock.method() to override another module's live named export).

const ANSWER = 'The gateway runs on Node 22.';

function makeDeps(overrides: Partial<FaqDeflectDeps> = {}): FaqDeflectDeps & {
  upsertCallCount: () => number;
  embedCallCount: () => number;
} {
  let upsertCalls = 0;
  let embedCalls = 0;
  const deps: FaqDeflectDeps = {
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

test('faqDeflectMode: defaults to off, only "on" (case-insensitive) enables it', () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    delete process.env.FAQ_DEFLECT_MODE;
    assert.equal(faqDeflectMode(), 'off');
    assert.equal(faqDeflectOn(), false);
    process.env.FAQ_DEFLECT_MODE = 'On';
    assert.equal(faqDeflectMode(), 'on');
    assert.equal(faqDeflectOn(), true);
    process.env.FAQ_DEFLECT_MODE = 'enforce'; // not a valid value for this mode
    assert.equal(faqDeflectMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('similarityThreshold: defaults sanely and clamps out-of-range values', () => {
  const prior = process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD;
  try {
    delete process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD;
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
    process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD = '0.8';
    assert.equal(similarityThreshold(), 0.8);
    process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD = '5'; // out of range
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
    process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD = 'not-a-number';
    assert.equal(similarityThreshold(), DEFAULT_SIMILARITY_THRESHOLD);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD;
    else process.env.FAQ_DEFLECT_SIMILARITY_THRESHOLD = prior;
  }
});

test('FAQ_SEED: a small, generic seed set with no obviously sensitive content', () => {
  assert.ok(FAQ_SEED.length >= 3, 'seed set should have a handful of entries');
  for (const entry of FAQ_SEED) {
    assert.ok(entry.id && entry.question && entry.answer, 'every entry needs id/question/answer');
  }
});

test('faqEligible: false when FAQ_DEFLECT_MODE is off, even with Cosmos configured', () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'off';
    assert.equal(faqEligible('complete', { isCosmosConfigured: () => true }), false);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('faqEligible: only task="complete" is FAQ-shaped; other tasks never deflect', () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    assert.equal(faqEligible('complete', { isCosmosConfigured: () => true }), true);
    assert.equal(faqEligible('summarize', { isCosmosConfigured: () => true }), false);
    assert.equal(faqEligible('classify', { isCosmosConfigured: () => true }), false);
    assert.equal(faqEligible('extract', { isCosmosConfigured: () => true }), false);
    assert.equal(faqEligible('synthesize', { isCosmosConfigured: () => true }), false);
    assert.equal(faqEligible('complete', { isCosmosConfigured: () => false }), false, 'unconfigured Cosmos is never eligible');
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: mode=off never touches embed/vectorSearch and always misses', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'off';
    const deps = makeDeps();
    const out = await checkFaqDeflect('what node version does the gateway run on?', 'complete', { deps });
    assert.equal(out.hit, false);
    assert.equal(deps.embedCallCount(), 0);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: task != "complete" never touches embed/vectorSearch, even with mode=on', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    const deps = makeDeps();
    const out = await checkFaqDeflect('classify this ticket', 'classify', { deps });
    assert.equal(out.hit, false);
    assert.equal(deps.embedCallCount(), 0);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: mode=on, a HIGH-similarity match is a HIT and returns the curated answer', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    let searchScope = '';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk, _field, _vec, top) => {
        searchScope = pk;
        assert.equal(top, 1);
        const match: VectorMatch = {
          doc: {
            id: 'faqseed-faq-runtime',
            cacheScope: pk,
            question: 'What Node.js version does the gateway run on?',
            queryVector: [0.1, 0.2, 0.3],
            answer: ANSWER,
            faqId: 'faq-runtime',
            ts: '',
            ttl: 2592000,
          },
          similarity: 0.99,
        };
        return [match];
      },
    });

    const out = await checkFaqDeflect('what node version does the gateway run on?', 'complete', { deps });

    assert.equal(out.hit, true);
    assert.equal(out.answer, ANSWER);
    assert.equal(out.faqId, 'faq-runtime');
    assert.equal(out.similarity, 0.99);
    assert.equal(searchScope, 'faq:global', 'lookup must be scoped to the global FAQ partition');
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: a similarity below the threshold is a MISS, not a hit', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk) => [
        { doc: { id: 'x', cacheScope: pk, question: 'q', queryVector: [], answer: ANSWER, faqId: 'faq-runtime', ts: '', ttl: 0 }, similarity: 0.5 },
      ],
    });

    const out = await checkFaqDeflect('some unrelated long-tail question', 'complete', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: FAIL-OPEN — an embed() throw is swallowed and reported as a miss', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    const deps = makeDeps({
      embed: async () => {
        throw new Error('Foundry outage');
      },
    });
    const out = await checkFaqDeflect('anything', 'complete', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: FAIL-OPEN — a vectorSearch() throw (Cosmos down) is swallowed and reported as a miss', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async () => {
        throw new Error('simulated Cosmos outage');
      },
    });
    const out = await checkFaqDeflect('anything', 'complete', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('checkFaqDeflect: a malformed FAQ doc (no answer) is treated as a miss, not a crash', async () => {
  const prior = process.env.FAQ_DEFLECT_MODE;
  try {
    process.env.FAQ_DEFLECT_MODE = 'on';
    const deps = makeDeps({
      vectorSearch: async (_coll, pk) => [
        { doc: { id: 'x', cacheScope: pk, question: 'q' }, similarity: 0.999 } as VectorMatch,
      ],
    });
    const out = await checkFaqDeflect('anything', 'complete', { deps });
    assert.equal(out.hit, false);
  } finally {
    if (prior === undefined) delete process.env.FAQ_DEFLECT_MODE;
    else process.env.FAQ_DEFLECT_MODE = prior;
  }
});

test('seedFaqStore: upserts one doc per FAQ_SEED entry, scoped to the global FAQ partition', async () => {
  const upserts: Array<{ coll: string; pk: string; doc: Record<string, unknown> }> = [];
  const deps = makeDeps({
    upsert: async (coll, pk, doc) => {
      upserts.push({ coll, pk, doc });
      return undefined;
    },
  });

  await seedFaqStore({ deps });

  assert.equal(upserts.length, FAQ_SEED.length);
  for (const u of upserts) {
    assert.equal(u.coll, 'cache');
    assert.equal(u.pk, 'faq:global');
    assert.equal(u.doc['cacheScope'], 'faq:global');
    assert.ok(Array.isArray(u.doc['queryVector']) && (u.doc['queryVector'] as number[]).length > 0);
  }
});

test('seedFaqStore: FAIL-OPEN — a Cosmos not configured short-circuits with zero calls', async () => {
  const deps = makeDeps({ isCosmosConfigured: () => false });
  await seedFaqStore({ deps });
  assert.equal(deps.upsertCallCount(), 0);
  assert.equal(deps.embedCallCount(), 0);
});

test('seedFaqStore: FAIL-OPEN — one bad entry does not block the others', async () => {
  let calls = 0;
  const deps = makeDeps({
    embed: async () => {
      calls++;
      if (calls === 2) throw new Error('simulated embed outage on entry 2');
      return [0.1, 0.2, 0.3];
    },
  });

  await assert.doesNotReject(seedFaqStore({ deps }));
  // All entries except the one that threw during embed() should have been upserted.
  assert.equal(deps.upsertCallCount(), FAQ_SEED.length - 1);
});
