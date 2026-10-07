import { test } from 'node:test';
import assert from 'node:assert/strict';

// Keep OpenAI configuration in this test process; loadEnv() caches its first parsed environment.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'synthetic-test-key';
process.env.OPENAI_HIGH_MODEL = 'gpt-5.6-sol';

const { chat } = await import('./foundry.js');

test('chat preserves finish_reason and refusal metadata additively on ChatResult', async () => {
  const responses = [
    { model: 'gpt-5.6-sol', choices: [{ finish_reason: 'length', message: { content: '{"verdict":"pass"}' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } },
    { model: 'gpt-5.6-sol', choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'synthetic refusal marker' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(responses.shift()), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const incomplete = await chat([{ role: 'user', content: 'return json' }], { tier: 'high', jsonMode: true });
    assert.equal(incomplete.text, '{"verdict":"pass"}');
    assert.equal(incomplete.finishReason, 'length');
    assert.equal(incomplete.refusal, undefined);
    assert.equal(incomplete.model, 'gpt-5.6-sol');
    assert.equal((incomplete.usage as { completion_tokens?: number }).completion_tokens, 3);

    const refused = await chat([{ role: 'user', content: 'return json' }], { tier: 'high', jsonMode: true });
    assert.equal(refused.text, '');
    assert.equal(refused.finishReason, 'stop');
    assert.equal(refused.refusal, 'synthetic refusal marker');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
