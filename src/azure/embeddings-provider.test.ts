import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches. This file pins the OPENAI provider, the Azure-exit path.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.EMBEDDINGS_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
// Foundry stays configured on purpose: the provider must be chosen by EMBEDDINGS_PROVIDER, not by
// which credentials happen to be present.
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-foundry-key';

const { embeddingsTarget, embed, embedBatch } = await import('./foundry.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('the provider is chosen by the flag, not by which credentials exist', () => {
  // Foundry is fully configured here. If presence-of-credentials decided, this would pick Azure and
  // the Azure exit would silently not happen.
  const t = embeddingsTarget();
  assert.equal(t?.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(t?.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(t?.headers['api-key'], undefined, 'the Azure header must not ride along');
});

test('THE PINNED MODEL: text-embedding-3-large, matching the index the vectors live in', () => {
  // Verified live 2026-08-15: OpenAI-direct and Azure Foundry both return 3072 dims for this model
  // with cosine similarity 0.99999791 -- the SAME vector space, so switching needs no re-embedding.
  // Any other model would silently collapse relevance across all 492,557 documents.
  assert.equal(embeddingsTarget()?.model, 'text-embedding-3-large');
});

test('the model is sent in the BODY for OpenAI (Azure addresses it by URL instead)', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => embed('hello'),
  );
  assert.equal(body.model, 'text-embedding-3-large');
  assert.equal(body.input, 'hello');
});

test('NO dimensions parameter is sent -- truncation would break comparability', async () => {
  // Passing `dimensions` shortens the vector into a space the index does not share. Same
  // silent-relevance-collapse failure as using the wrong model, by a different route.
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => embed('x'),
  );
  assert.equal('dimensions' in body, false);
});

test('embed returns the vector', async () => {
  const v = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })) as unknown as typeof fetch,
    () => embed('hi'),
  );
  assert.deepEqual(v, [0.1, 0.2, 0.3]);
});

test('embedBatch preserves input ORDER, so vector[i] still matches texts[i]', async () => {
  // Deliberately returned out of order: the caller pairs by position, so a provider that reorders
  // would silently attach every embedding to the wrong document.
  const v = await withStubbedFetch(
    (async () =>
      new Response(
        JSON.stringify({ data: [
          { embedding: [3], index: 2 },
          { embedding: [1], index: 0 },
          { embedding: [2], index: 1 },
        ] }),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => embedBatch(['a', 'b', 'c']),
  );
  assert.deepEqual(v, [[1], [2], [3]]);
});

test('an empty batch does no network call at all', async () => {
  let called = false;
  const v = await withStubbedFetch(
    (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    () => embedBatch([]),
  );
  assert.deepEqual(v, []);
  assert.equal(called, false);
});

test('an API failure throws with the provider message, not a bare status', async () => {
  await assert.rejects(
    () =>
      withStubbedFetch(
        (async () =>
          new Response(JSON.stringify({ error: { message: 'invalid_api_key' } }), { status: 401 })) as unknown as typeof fetch,
        () => embed('x'),
      ),
    /invalid_api_key/,
  );
});

test('the Azure URL shape is NOT used on the OpenAI path', async () => {
  // The two providers disagree on how the model is addressed. Sending OpenAI an Azure-style
  // /openai/deployments/... URL 404s, and sending Azure a bare `model` field is ignored -- either
  // way the mistake surfaces as "no vector", which degrades to keyword-only search rather than
  // erroring, so it is worth pinning explicitly.
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => embed('x'),
  );
  assert.equal(seenUrl, 'https://api.openai.com/v1/embeddings');
  assert.equal(seenUrl.includes('/openai/deployments/'), false);
  assert.equal(seenUrl.includes('api-version'), false);
});
