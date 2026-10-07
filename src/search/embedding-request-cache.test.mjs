import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingRequestCache, embedWithRequestCache } from './embedding-request-cache.ts';

const query = 'same non-sensitive test query';

function requestScopedEmbedder(provider, options) {
  const cache = createEmbeddingRequestCache();
  const now = options?.now ?? Date.now;
  return (text, budget) => embedWithRequestCache(cache, text, () => provider(text, budget), budget, now);
}

async function roomLookup(room, q, embedForRequest, budget) {
  // Models the Azure/OpenSearch retrieval call: each room uses the embedding only to build its own
  // query, so caching the vector must leave room-specific retrieval values unchanged.
  const vector = await embedForRequest(q, budget);
  return { room, score: vector[0] + room.length, vector };
}

test('two same-query room lookups share one provider call and preserve retrieval values', async () => {
  let calls = 0;
  const provider = async (text) => {
    calls++;
    assert.equal(text, query);
    return [0.125, 0.5, 0.875];
  };
  const budget = { deadlineAtMs: Date.now() + 5_000 };
  const baseline = await Promise.all([
    roomLookup('memory-exec', query, provider, budget),
    roomLookup('commons-company-journal', query, provider, budget),
  ]);
  assert.equal(calls, 2, 'uncached baseline makes one provider call per room');

  calls = 0;
  const cached = requestScopedEmbedder(provider);
  const actual = await Promise.all([
    roomLookup('memory-exec', query, cached, budget),
    roomLookup('commons-company-journal', query, cached, budget),
  ]);
  assert.equal(calls, 1, 'same-query concurrent rooms share one provider call');
  assert.deepEqual(actual, baseline, 'room-level retrieval output remains unchanged');
});

test('a new tool request gets an isolated cache', async () => {
  let calls = 0;
  const provider = async () => { calls++; return [1, 2, 3]; };
  const budget = { deadlineAtMs: Date.now() + 5_000 };
  const firstRequest = requestScopedEmbedder(provider);
  const secondRequest = requestScopedEmbedder(provider);

  const [a, b] = await Promise.all([
    firstRequest(query, budget),
    secondRequest(query, budget),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 2, 'separate requests never share vectors or in-flight provider work');
});

test('rejected embedding promises stay in this request and a new request starts fresh', async () => {
  let calls = 0;
  const provider = async () => {
    calls++;
    if (calls === 1) throw new Error('embedding_provider_unavailable');
    return [7, 8];
  };
  const firstRequest = requestScopedEmbedder(provider);
  const firstBudget = { deadlineAtMs: Date.now() + 5_000 };
  await assert.rejects(firstRequest(query, firstBudget), /embedding_provider_unavailable/);
  await assert.rejects(firstRequest(query, firstBudget), /embedding_provider_unavailable/);
  assert.equal(calls, 1, 'a second room in this request does not retry the failed provider call');

  const secondRequest = requestScopedEmbedder(provider);
  assert.deepEqual(await secondRequest(query, { deadlineAtMs: Date.now() + 5_000 }), [7, 8]);
  assert.equal(calls, 2, 'a new request gets a fresh cache and can call the provider');
});

test('expired or cancelled callers cannot bypass their search budget through a cache hit', async () => {
  let now = 1_000;
  let calls = 0;
  const cache = requestScopedEmbedder(async () => { calls++; return [1]; }, { now: () => now });
  const live = { deadlineAtMs: 2_000 };
  assert.deepEqual(await cache(query, live), [1]);
  assert.deepEqual(await cache(query, live), [1]);
  assert.equal(calls, 1);

  now = 2_000;
  await assert.rejects(cache(query, live), { name: 'TimeoutError', message: 'Search request deadline exceeded' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache(query, { signal: controller.signal }), { name: 'TimeoutError', message: 'Search request deadline exceeded' });
  assert.equal(calls, 1, 'a cache hit does not launch a new provider call or skip the budget gate');
});

test('the bounded three-query fan-out across eight rooms uses three embeddings', async () => {
  let calls = 0;
  const cache = requestScopedEmbedder(async (text) => { calls++; return [text.length]; });
  const budget = { deadlineAtMs: Date.now() + 5_000 };
  const subQueries = ['topic alpha', 'topic beta', 'topic gamma'];
  const rooms = Array.from({ length: 8 }, (_, i) => `room-${i}`);
  await Promise.all(rooms.flatMap((room) => subQueries.map((q) => roomLookup(room, q, cache, budget))));
  assert.equal(calls, 3, '24 room/query pairs reduce to one embedding per distinct sub-query');
});

test('provider failure text passes through without adding query text or logging it', async () => {
  const safeError = new Error('embedding_provider_unavailable');
  const cache = requestScopedEmbedder(async () => { throw safeError; });
  await assert.rejects(cache(query, { deadlineAtMs: Date.now() + 5_000 }), (error) => {
    assert.equal(error, safeError);
    assert.equal(error.message.includes(query), false);
    return true;
  });
});

test('a mixed-budget waiter starts with its own signal instead of waiting on the owner promise', async () => {
  const ownerController = new AbortController();
  const waiterController = new AbortController();
  const ownerBudget = { deadlineAtMs: Date.now() + 10_000, signal: ownerController.signal };
  const waiterBudget = { deadlineAtMs: Date.now() + 1_000, signal: waiterController.signal };
  const cache = createEmbeddingRequestCache();
  const startedWith = [];
  const provider = (_text, budget) => new Promise((_resolve, reject) => {
    startedWith.push(budget);
    if (budget.signal.aborted) reject(new DOMException('caller cancelled', 'AbortError'));
    else budget.signal.addEventListener('abort', () => reject(new DOMException('caller cancelled', 'AbortError')), { once: true });
  });

  const owner = embedWithRequestCache(cache, query, () => provider(query, ownerBudget), ownerBudget);
  const waiter = embedWithRequestCache(cache, query, () => provider(query, waiterBudget), waiterBudget);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(startedWith.length, 2, 'different budget identities must not share the pending provider call');
  assert.equal(startedWith[1], waiterBudget, 'the independent call receives its own deadline and signal');

  waiterController.abort();
  await assert.rejects(waiter, { name: 'AbortError', message: 'caller cancelled' });
  ownerController.abort();
  await assert.rejects(owner, { name: 'AbortError', message: 'caller cancelled' });
});
