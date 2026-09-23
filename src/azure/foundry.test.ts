import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s required vars, then poison the retired Foundry settings.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin the retired provider explicitly so this file proves stale settings stay inert.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.FOUNDRY_OPENAI_ENDPOINT ||= 'https://retired-foundry.example.invalid';
process.env.FOUNDRY_KEY ||= 'test-retired-foundry-key';

const { embedBatch, foundryConfigured, chatTarget, chatConfigured, promptCacheKey, chat } = await import('./foundry.js');

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

test('retired Foundry: endpoint and key never make the provider appear configured', () => {
  assert.equal(foundryConfigured(), false);
});

// ── chatTarget()/chatConfigured() DEFAULT scenario: LLM_PROVIDER is unset here, so this file also
// covers "byte-identical to every prior deploy" for the chat path (see chat-provider.test.ts and
// chat-provider-overrides.test.ts for the LLM_PROVIDER=openai scenarios, in their own processes). ──

test('retired Foundry: chatConfigured() remains false despite poisoned settings', () => {
  assert.equal(chatConfigured(), false);
});

test('retired Foundry: chatTarget() never returns an Azure deployment URL', () => {
  assert.equal(chatTarget('standard'), null);
});

test('retired Foundry: high-tier selection is unavailable', () => {
  assert.equal(chatTarget('high'), null);
});

test('retired Foundry: router selection is unavailable', () => {
  assert.equal(chatTarget('router'), null);
});

test('retired Foundry: embedBatch returns no vectors and makes no provider call', async () => {
  let calls = 0;
  await withStubbedFetch(
    (async () => {
      calls++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    async () => {
      assert.equal(await embedBatch(['alpha query', 'beta query']), null);
    },
  );
  assert.equal(calls, 0);
});

test('retired Foundry: multi-item embedBatch cannot issue a request', async () => {
  let calls = 0;
  await withStubbedFetch(
    (async () => {
      calls++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    async () => {
      assert.equal(await embedBatch(['q1', 'q2', 'q3', 'q4']), null);
    },
  );
  assert.equal(calls, 0);
});

test('retired Foundry: an empty embedBatch returns no vectors without a network call', async () => {
  let callCount = 0;
  await withStubbedFetch(
    (async () => {
      callCount++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch([]);
      assert.equal(vectors, null);
      assert.equal(callCount, 0);
    },
  );
});

test('retired Foundry: malformed provider responses are unreachable', async () => {
  await withStubbedFetch(
    (async () => {
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    async () => {
      const vectors = await embedBatch(['first', 'second']);
      assert.equal(vectors, null);
    },
  );
});

// ---- provider gating for the 2026-09-03 OpenAI cost levers (serviceTier is OpenAI-direct ONLY) ----

test('retired Foundry: chat with serviceTier fails before provider I/O', async () => {
  let calls = 0;
  await withStubbedFetch(
    (async () => {
      calls++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    () => assert.rejects(() => chat([{ role: 'user', content: 'x' }], { serviceTier: 'flex' }), /Foundry not configured/),
  );
  assert.equal(calls, 0);
});

test('retired Foundry: chat with promptCacheKey fails before provider I/O', async () => {
  let calls = 0;
  await withStubbedFetch(
    (async () => {
      calls++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    () => assert.rejects(() => chat([{ role: 'user', content: 'x' }], { promptCacheKey: 'llm:cto:summarize:standard' }), /Foundry not configured/),
  );
  assert.equal(calls, 0);
});

test('retired Foundry: router-tier chat fails before provider I/O', async () => {
  let calls = 0;
  await withStubbedFetch(
    (async () => {
      calls++;
      throw new Error('retired provider must not be contacted');
    }) as typeof fetch,
    () => assert.rejects(() => chat([{ role: 'user', content: 'x' }], { tier: 'router' }), /Foundry not configured/),
  );
  assert.equal(calls, 0);
});
