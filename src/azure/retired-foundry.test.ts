import test from 'node:test';
import assert from 'node:assert/strict';

// This file owns its module process. Poisoned retired-provider configuration must
// be tested before the environment cache is populated by another test module.
process.env.CIO_SITE_ID = 'synthetic-site';
process.env.CIO_TRACK_KEY = 'synthetic-track';
process.env.CIO_APP_API_BEARER = 'synthetic-bearer';
process.env.PERPLEXITY_CONNECTOR_TOKEN = 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN = 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET = 'x'.repeat(32);
process.env.LLM_PROVIDER = 'foundry';
process.env.EMBEDDINGS_PROVIDER = 'foundry';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://retired-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'synthetic-retired-key';
process.env.FOUNDRY_ROUTER_ENDPOINT = 'https://retired-router.example.invalid';
process.env.FOUNDRY_ROUTER_KEY = 'synthetic-retired-router-key';

const {
  chat,
  chatConfigured,
  chatTarget,
  deploymentForTier,
  embed,
  embeddingsTarget,
  foundryConfigured,
  routerConfigured,
} = await import('./foundry.js');

test('poisoned retired Foundry configuration cannot be advertised or selected', () => {
  assert.equal(foundryConfigured(), false);
  assert.equal(routerConfigured(), false);
  assert.equal(deploymentForTier('standard'), null);
  assert.equal(chatConfigured(), false);
  assert.equal(chatTarget('standard'), null);
  assert.equal(embeddingsTarget(), null);
});

test('retired Foundry configuration makes no provider network call', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('retired provider must not be contacted');
  }) as typeof fetch;
  try {
    assert.equal(await embed('synthetic query'), null);
    await assert.rejects(
      () => chat([{ role: 'user', content: 'synthetic' }]),
      /Foundry not configured/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
