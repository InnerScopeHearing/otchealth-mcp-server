import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- see chat-provider-router-reasoning-off.test.ts's header for why a custom
// OPENAI_ROUTER_REASONING_EFFORT value needs its own process.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.OPENAI_ROUTER_REASONING_EFFORT = 'medium';

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

test('OPENAI_ROUTER_REASONING_EFFORT="medium" overrides the "low" built-in default for router-tier gpt-5.6-family calls', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'gpt-5.6-luna' }), { status: 200 });
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { tier: 'router' }),
  );
  assert.equal(body.reasoning_effort, 'medium');
});

test('the override still yields to an explicit caller reasoningEffort', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'gpt-5.6-luna' }), { status: 200 });
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { tier: 'router', reasoningEffort: 'none' }),
  );
  assert.equal(body.reasoning_effort, 'none');
});
