import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so OPENAI_API_KEY must be unset BEFORE any
// loadEnv() call to prove the "selected but unconfigured" path (mutating process.env mid-file, as
// chat-provider.test.ts's own header explains, has no effect once the cache is warm). Foundry is
// left FULLY CONFIGURED on purpose -- the point is that LLM_PROVIDER=openai must not fall back to
// a configured Foundry, it must report unconfigured.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = '';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-foundry-key';

const { chatTarget, chatConfigured, chat, embeddingsTarget, FoundryError } = await import('./foundry.js');

test('chatTarget() is null when LLM_PROVIDER=openai but OPENAI_API_KEY is unset, even though Foundry is fully configured', () => {
  assert.equal(chatTarget(), null, 'must not silently fall back to the configured Foundry credentials');
});

test('chatConfigured() is false in the same scenario', () => {
  assert.equal(chatConfigured(), false);
});

test('embeddingsTarget() is UNAFFECTED: EMBEDDINGS_PROVIDER defaults to foundry independently of LLM_PROVIDER', () => {
  const t = embeddingsTarget();
  assert.equal(t?.headers['api-key'], 'test-foundry-key');
});

test('chat() throws an OpenAI-specific, non-misleading error (not the Foundry-flavoured message)', async () => {
  await assert.rejects(
    () => chat([{ role: 'user', content: 'x' }]),
    (err: unknown) =>
      err instanceof FoundryError &&
      /LLM_PROVIDER=openai/.test(err.message) &&
      /OPENAI_API_KEY/.test(err.message) &&
      !/FOUNDRY_OPENAI_ENDPOINT/.test(err.message),
  );
});
