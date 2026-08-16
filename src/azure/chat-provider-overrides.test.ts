import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL/
// OPENAI_ROUTER_MODEL overrides MUST be set before this file's first loadEnv() call (the first
// chatTarget()/chatConfigured() call below) to take effect at all. Mirrors the pattern
// chat-provider.test.ts and embeddings-provider.test.ts already use for their own pinned scenario.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.OPENAI_CHAT_MODEL = 'gpt-real-standard';
process.env.OPENAI_HIGH_MODEL = 'gpt-real-high';
process.env.OPENAI_ROUTER_MODEL = 'gpt-real-router';

const { chatTarget } = await import('./foundry.js');

test('OPENAI_CHAT_MODEL overrides the tier:"standard" default guess', () => {
  assert.equal(chatTarget('standard')?.model, 'gpt-real-standard');
  assert.equal(chatTarget()?.model, 'gpt-real-standard', 'tier omitted behaves like "standard"');
});

test('OPENAI_HIGH_MODEL overrides the tier:"high" default guess', () => {
  assert.equal(chatTarget('high')?.model, 'gpt-real-high');
});

test('OPENAI_ROUTER_MODEL overrides the tier:"router" fallback once a real routing model id is confirmed', () => {
  // With the override set, router no longer collapses to standard -- it uses the confirmed id.
  assert.equal(chatTarget('router')?.model, 'gpt-real-router');
  assert.notEqual(chatTarget('router')?.model, chatTarget('standard')?.model);
});
