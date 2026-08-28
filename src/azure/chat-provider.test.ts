import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches. This file pins the OPENAI provider for CHAT, the Azure-exit
// path (mirrors embeddings-provider.test.ts, which does the same for EMBEDDINGS_PROVIDER).
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
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
// Foundry stays fully configured on purpose: the provider must be chosen by LLM_PROVIDER, not by
// which credentials happen to be present -- the exact same discipline embeddings-provider.test.ts
// enforces for EMBEDDINGS_PROVIDER. Also proves EMBEDDINGS_PROVIDER and LLM_PROVIDER are
// independent: this file never sets EMBEDDINGS_PROVIDER, so embeddingsTarget() must still resolve
// to Foundry while chatTarget() resolves to OpenAI.
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-foundry-key';
process.env.FOUNDRY_CHAT_DEPLOYMENT = 'gpt-5.1';
process.env.FOUNDRY_HIGH_DEPLOYMENT = 'gpt-5.4';

const { chatTarget, chatConfigured, chat, embeddingsTarget, FoundryError } = await import('./foundry.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('the chat provider is chosen by LLM_PROVIDER, not by which credentials exist', () => {
  // Foundry is fully configured here. If presence-of-credentials decided, this would pick Azure and
  // the Azure exit would silently not happen.
  const t = chatTarget();
  assert.equal(t?.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(t?.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(t?.headers['api-key'], undefined, 'the Azure header must not ride along');
});

test('chatConfigured() reflects the ACTIVE provider (openai), true even though FOUNDRY_* is also set', () => {
  assert.equal(chatConfigured(), true);
});

test('LLM_PROVIDER and EMBEDDINGS_PROVIDER move independently: this file only sets LLM_PROVIDER, so embeddings stay on Foundry', () => {
  const t = embeddingsTarget();
  assert.equal(t?.headers['api-key'], 'test-foundry-key', 'embeddings must still be Foundry-routed');
  assert.equal(t?.headers.Authorization, undefined);
});

test('tier "standard" defaults the OpenAI model to the Foundry deployment-name string (the documented judgement call)', () => {
  assert.equal(chatTarget('standard')?.model, 'gpt-5.1');
  assert.equal(chatTarget()?.model, 'gpt-5.1', 'tier omitted behaves like "standard"');
});

test('tier "high" resolves to the high-tier default', () => {
  assert.equal(chatTarget('high')?.model, 'gpt-5.4');
});

test('tier "router" has no OpenAI product equivalent, so it collapses to the standard model (matches the unconfigured-router Foundry fallback)', () => {
  assert.equal(chatTarget('router')?.model, chatTarget('standard')?.model);
});

// OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL/OPENAI_ROUTER_MODEL override coverage lives in its own file
// (chat-provider-overrides.test.ts): loadEnv() caches per process on first call, and this file's
// tests above already forced that first read with the *_MODEL vars unset/blank, so setting them
// here would be a no-op that silently asserts nothing -- exactly the trap the task brief warns
// about. A dedicated file gets its own process and can set them before any loadEnv() call.

test('a deploymentOverride forces an exact OpenAI model id regardless of tier', () => {
  assert.equal(chatTarget('standard', 'gpt-forced')?.model, 'gpt-forced');
  assert.equal(chatTarget('high', 'gpt-forced')?.model, 'gpt-forced');
});

test('the model is sent in the BODY for OpenAI (Azure addresses it by URL deployment instead)', async () => {
  let body: Record<string, unknown> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }], model: 'gpt-5.1' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'hello' }]),
  );
  assert.equal(body.model, 'gpt-5.1');
  assert.equal(Array.isArray(body.messages), true);
});

test('the Azure URL shape is NOT used on the OpenAI chat path', async () => {
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 });
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }]),
  );
  assert.equal(seenUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seenUrl.includes('/openai/deployments/'), false);
  assert.equal(seenUrl.includes('api-version'), false);
});

test('chat() returns the model the API echoed back, falling back to the resolved label only when absent', async () => {
  const withEcho = await withStubbedFetch(
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'a' } }], model: 'gpt-5.1-2026-01-01' }), {
        status: 200,
      })) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }]),
  );
  assert.equal(withEcho.model, 'gpt-5.1-2026-01-01');

  const withoutEcho = await withStubbedFetch(
    (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'b' } }] }), { status: 200 })) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { deployment: 'gpt-fallback-label' }),
  );
  assert.equal(withoutEcho.model, 'gpt-fallback-label');
});

test('a model_not_found-style 404 fails LOUDLY (the safe failure mode for a wrong tier->model guess), never silently', async () => {
  await assert.rejects(
    () =>
      withStubbedFetch(
        (async () =>
          new Response(
            JSON.stringify({ error: { message: "The model `gpt-5.4` does not exist or you do not have access to it." } }),
            { status: 404 },
          )) as unknown as typeof fetch,
        () => chat([{ role: 'user', content: 'x' }], { tier: 'high' }),
      ),
    (err: unknown) => err instanceof FoundryError && /does not exist/.test(err.message),
  );
});

// The "LLM_PROVIDER=openai but OPENAI_API_KEY unset" scenario is NOT testable here: loadEnv()
// caches on its first call, which every test above already forced with OPENAI_API_KEY set to
// 'sk-test-key' -- the exact trap this file's own header warns about, one level removed (mutating
// process.env.OPENAI_API_KEY mid-file has no effect on the cached parse). See
// chat-provider-unconfigured.test.ts for that scenario in its own process.
