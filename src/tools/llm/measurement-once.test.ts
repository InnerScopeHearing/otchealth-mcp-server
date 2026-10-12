import { test, before } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  Object.assign(process.env, {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32), ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32), LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'measurement-test-key',
    OPENAI_CHAT_MODEL: 'gpt-5.6-sol', OPENAI_HIGH_MODEL: 'gpt-5.6-sol',
    EMBEDDINGS_PROVIDER: 'openai', COSMOS_ENDPOINT: 'https://measurement.invalid', COSMOS_KEY: 'test',
    LLM_CACHE_MODE: 'on', FAQ_DEFLECT_MODE: 'on', OPENAI_FLEX_BACKGROUND: '1',
  });
});

const { chat, FoundryError } = await import('../../azure/foundry.js');
const { registerLlmAzure } = await import('./azure.js');
const { requestContext, currentCallerHash } = await import('../../server/request-context.js');

const goodCompletion = () => new Response(JSON.stringify({
  model: 'gpt-5.6-sol',
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

async function withFetch(stub: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try { await run(); } finally { globalThis.fetch = previous; }
}

function fakeServer(): { server: any; handlers: Record<string, (args: unknown) => Promise<any>> } {
  const handlers: Record<string, (args: unknown) => Promise<any>> = {};
  return {
    server: { registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<any>) => { handlers[name] = handler; } },
    handlers,
  };
}

async function callToolAs(callerAgent: string, args: Record<string, unknown>): Promise<any> {
  const { server, handlers } = fakeServer();
  let result: any;
  await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent }, async () => {
    registerLlmAzure(server, currentCallerHash);
    result = await handlers.llm_azure!(args);
  });
  return result;
}

test('singleAttempt success makes exactly one physical request, ignores flex, and requires provider usage/model', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.service_tier, undefined);
    return goodCompletion();
  }, async () => {
    const result = await chat([{ role: 'user', content: 'synthetic' }], { tier: 'high', singleAttempt: true, serviceTier: 'flex' });
    assert.equal(result.providerModel, 'gpt-5.6-sol');
    assert.equal((result.usage as any).total_tokens, 14);
  });
  assert.equal(calls, 1);
});

for (const status of [429, 500]) {
  test(`singleAttempt does not retry HTTP ${status}`, async () => {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'synthetic upstream failure' } }), { status });
    }, async () => {
      await assert.rejects(chat([{ role: 'user', content: 'synthetic' }], { tier: 'high', singleAttempt: true }), FoundryError);
    });
    assert.equal(calls, 1);
  });
}

test('singleAttempt does not retry a timed out physical request', async () => {
  let calls = 0;
  const abort = new AbortController();
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
    setTimeout(() => abort.abort(new Error('synthetic timeout')), 10);
  }) as Promise<Response>, async () => {
    await assert.rejects(chat([{ role: 'user', content: 'synthetic' }], { tier: 'high', singleAttempt: true, signal: abort.signal }));
  });
  assert.equal(calls, 1);
});

test('singleAttempt suppresses flex capacity fallback even when caller supplied flex', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).service_tier, undefined);
    return new Response(JSON.stringify({ error: { message: 'Flex does not have sufficient resources available' } }), { status: 429 });
  }, async () => {
    await assert.rejects(chat([{ role: 'user', content: 'synthetic' }], { tier: 'high', singleAttempt: true, serviceTier: 'flex' }), FoundryError);
  });
  assert.equal(calls, 1);
});

test('normal mode retains its retry and flex-fallback physical calls', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (body.service_tier === 'flex') {
      return new Response(JSON.stringify({ error: { message: 'Flex does not have sufficient resources available' } }), { status: 429 });
    }
    if (calls === 3) return new Response('synthetic transient', { status: 503 });
    return goodCompletion();
  }, async () => {
    const result = await chat([{ role: 'user', content: 'synthetic' }], { tier: 'high', serviceTier: 'flex' });
    assert.equal(result.model, 'gpt-5.6-sol');
  });
  assert.equal(calls, 4);
});

test('normal non-flex mode still performs its existing one retry and keeps the default result shape', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return calls === 1
      ? new Response('synthetic transient', { status: 500 })
      : goodCompletion();
  }, async () => {
    const result = await chat([{ role: 'user', content: 'synthetic' }], { tier: 'high' });
    assert.equal(result.model, 'gpt-5.6-sol');
    assert.equal(result.providerModel, undefined);
  });
  assert.equal(calls, 2);
});

test('tool singleAttempt bypasses FAQ and semantic cache, returns complete receipt only after provider success', async () => {
  const seen: string[] = [];
  await withFetch(async (url) => {
    seen.push(String(url));
    assert.match(String(url), /\/chat\/completions$/);
    return goodCompletion();
  }, async () => {
    const response = await callToolAs('cto', {
      task: 'complete', input: 'What Node.js version does the gateway run?', tier: 'high', singleAttempt: true,
      latencyClass: 'background',
    });
    const result = response.structuredContent.result;
    assert.equal(result.actual_single_attempt, true);
    assert.equal(result.provider_attempt_count, 1);
    assert.equal(result.retry_accounting, 'complete');
    assert.equal(result.cache_hit, false);
    assert.equal(result.model, 'gpt-5.6-sol');
  });
  assert.equal(seen.length, 1, 'only one provider request; FAQ and semantic-cache embeddings/query/write never run');
});

test('singleAttempt is refused for other caller lanes before any provider or cache request', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return goodCompletion(); }, async () => {
    const response = await callToolAs('cfo', { task: 'complete', input: 'synthetic', singleAttempt: true });
    assert.equal(response.structuredContent.result.error, 'single_attempt_not_authorized');
    assert.equal(response.structuredContent.result.retry_accounting, undefined);
  });
  assert.equal(calls, 0);
});

test('singleAttempt incomplete provider usage/model has no complete receipt', async () => {
  await withFetch(async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'synthetic' } }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 15 },
  }), { status: 200 }), async () => {
    const response = await callToolAs('developer', { task: 'complete', input: 'synthetic', singleAttempt: true });
    const result = response.structuredContent.result;
    assert.equal(result.error, 'single_attempt_provider_error');
    assert.equal(result.retry_accounting, undefined);
    assert.equal(result.provider_attempt_count, undefined);
  });
});
