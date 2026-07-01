import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then configure Foundry so cfg() resolves.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-foundry-key';

const { embedBatch, foundryConfigured } = await import('./foundry.js');

// Pure network mocking via a direct globalThis.fetch reassignment (a genuine global, not another
// module's live named export, so node:test's inability to redefine module exports does not apply
// here). See src/memory/hot-cache.test.ts for that limitation and src/util/fetch-budget.test.ts
// for the same stubbing pattern used against fetchWithBudget, which post() now calls internally.
async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('foundry: is considered configured once endpoint + key are set', () => {
  assert.equal(foundryConfigured(), true);
});

test('embedBatch: preserves input order so vector[i] corresponds to texts[i], even when the API returns data out of order', async () => {
  const texts = ['alpha query', 'beta query', 'gamma query'];
  let capturedBody: unknown;
  await withStubbedFetch(
    (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      // Deliberately return the embeddings SHUFFLED and out of array order, each tagged with its
      // real `.index` from the Azure OpenAI /embeddings response shape, to prove embedBatch sorts
      // by `.index` rather than trusting bare response-array order.
      return new Response(
        JSON.stringify({
          data: [
            { index: 2, embedding: [2, 2, 2] }, // gamma
            { index: 0, embedding: [0, 0, 0] }, // alpha
            { index: 1, embedding: [1, 1, 1] }, // beta
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch(texts);
      assert.ok(vectors, 'embedBatch should return a non-null array when configured');
      assert.equal(vectors!.length, 3);
      // vector[i] must correspond to texts[i] regardless of the shuffled response order above.
      assert.deepEqual(vectors![0], [0, 0, 0], 'texts[0] (alpha) must map to index-0 embedding');
      assert.deepEqual(vectors![1], [1, 1, 1], 'texts[1] (beta) must map to index-1 embedding');
      assert.deepEqual(vectors![2], [2, 2, 2], 'texts[2] (gamma) must map to index-2 embedding');
    },
  );
  assert.deepEqual(
    (capturedBody as { input?: string[] })?.input,
    texts,
    'the batch call must send all texts as a single array input, not one call per text',
  );
});

test('embedBatch: sends exactly ONE request for a multi-item batch (not one call per text)', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1] },
            { index: 1, embedding: [2] },
            { index: 2, embedding: [3] },
            { index: 3, embedding: [4] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch(['q1', 'q2', 'q3', 'q4']);
      assert.equal(vectors?.length, 4);
      assert.equal(callCount, 1, 'batching must issue a single HTTP call for the whole batch');
    },
  );
});

test('embedBatch: an empty input list returns an empty array without making a network call', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch([]);
      assert.deepEqual(vectors, []);
      assert.equal(callCount, 0);
    },
  );
});

test('embedBatch: a response missing the `.index` field falls back to array position (defensive, still order-correct for a well-behaved API)', async () => {
  await withStubbedFetch(
    (async () => {
      return new Response(
        JSON.stringify({
          data: [{ embedding: [10] }, { embedding: [20] }],
        }),
        { status: 200 },
      );
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch(['first', 'second']);
      assert.deepEqual(vectors, [[10], [20]]);
    },
  );
});
