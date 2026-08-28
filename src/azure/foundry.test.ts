import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then configure Foundry so cfg() resolves.
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

const { embedBatch, foundryConfigured, chatTarget, chatConfigured, promptCacheKey } = await import('./foundry.js');

test('promptCacheKey: stable across calls sharing a system prefix, and independent of user content', () => {
  const sys = { role: 'system' as const, content: 'You are a precise summarizer.' };
  const a = promptCacheKey('gpt-5.1', [sys, { role: 'user', content: 'summarize A' }]);
  const b = promptCacheKey('gpt-5.1', [sys, { role: 'user', content: 'a completely different body B' }]);
  assert.equal(a, b, 'same system prefix + deployment -> same cache-affinity key regardless of user content');
  assert.match(a, /^oc-[0-9a-f]{24}$/);
});

test('promptCacheKey: differs by deployment and by system prefix', () => {
  const sys = { role: 'system' as const, content: 'You are a classifier.' };
  assert.notEqual(promptCacheKey('gpt-5.1', [sys]), promptCacheKey('gpt-5.4', [sys]));
  assert.notEqual(
    promptCacheKey('gpt-5.1', [{ role: 'system', content: 'prompt one' }]),
    promptCacheKey('gpt-5.1', [{ role: 'system', content: 'prompt two' }]),
  );
});

// Pure network mocking via a direct globalThis.fetch reassignment (a genuine global, not another
// module's live named export, so node:test's inability to redefine module exports does not apply
// here). See src/memory/hot-cache.test.ts for that limitation and src/util/fetch-budget.test.ts
// for the same stubbing pattern used against fetchWithBudget, which postToTarget() now calls
// internally.
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

// ── chatTarget()/chatConfigured() DEFAULT scenario: LLM_PROVIDER is unset here, so this file also
// covers "byte-identical to every prior deploy" for the chat path (see chat-provider.test.ts and
// chat-provider-overrides.test.ts for the LLM_PROVIDER=openai scenarios, in their own processes). ──

test('chatConfigured() is true by default (LLM_PROVIDER unset -> foundry) once Foundry endpoint + key are set', () => {
  assert.equal(chatConfigured(), true);
});

test('chatTarget() defaults to the Azure deployment URL shape, addressing the model via the URL (not the body)', () => {
  const t = chatTarget('standard');
  assert.equal(t?.url, 'https://otchealth-foundry.example.invalid/openai/deployments/gpt-5.1/chat/completions?api-version=2024-08-01-preview');
  assert.equal(t?.headers['api-key'], 'test-foundry-key');
  assert.equal(t?.headers.Authorization, undefined, 'the OpenAI-direct auth header must not ride along');
  assert.equal(t?.model, null, 'Azure addresses the model via the URL deployment segment, not the body');
  assert.equal(t?.resolvedLabel, 'gpt-5.1');
});

test('chatTarget() tier "high" resolves the high deployment', () => {
  assert.equal(chatTarget('high')?.resolvedLabel, 'gpt-5.4');
});

test('chatTarget() tier "router" falls back to standard when the router endpoint/key are unset (byte-identical to the pre-chatTarget() chat() behavior)', () => {
  assert.equal(chatTarget('router')?.resolvedLabel, 'gpt-5.1');
  assert.equal(chatTarget('router')?.url.includes('otchealth-foundry.example.invalid'), true);
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
