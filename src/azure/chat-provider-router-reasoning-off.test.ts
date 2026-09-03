import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first call, so OPENAI_ROUTER_REASONING_EFFORT must be
// set before this file's first loadEnv() call (the first chatTarget()/chat() call below) to take
// effect at all. Mirrors chat-provider-overrides.test.ts's own header for the identical reason.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.OPENAI_ROUTER_REASONING_EFFORT = 'off';

const { chat } = await import('./foundry.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('OPENAI_ROUTER_REASONING_EFFORT=off disables the router-tier default entirely -- reasoning_effort is omitted, not sent as "off"', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'gpt-5.6-luna' }), { status: 200 });
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { tier: 'router' }),
  );
  assert.equal(body.model, 'gpt-5.6-luna', 'sanity: router really did resolve to a gpt-5.6-family model');
  assert.equal('reasoning_effort' in body, false);
  assert.notEqual(body.reasoning_effort, 'off', 'the literal string "off" must never be sent to the API');
});

test('an EXPLICIT reasoningEffort still wins even with the env default disabled ("off" only disables the DEFAULT, not a caller override)', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'gpt-5.6-luna' }), { status: 200 });
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { tier: 'router', reasoningEffort: 'medium' }),
  );
  assert.equal(body.reasoning_effort, 'medium');
});
