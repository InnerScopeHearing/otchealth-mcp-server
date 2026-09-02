// Own file/process (loadEnv() caches per process on first call -- see foundry.test.ts's own header
// for why every OpenAI-provider test file in this directory follows this convention). This file
// proves the END-TO-END wiring: a real embed()/embedBatch()/chat() call on the OpenAI-direct branch
// actually reaches recordOpenAIUsage() -> emitOpenAIFleetMetrics(), not just that the code compiles.
// Both `api.openai.com` and the Datadog series endpoint are reached through the SAME stubbed
// globalThis.fetch, distinguished by URL, so no real network call is ever made by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.EMBEDDINGS_PROVIDER = 'openai';
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-foundry-key';
// Datadog emission is otherwise a no-op without a key (see datadog-metrics.ts's resolveDdCreds) --
// set one here so this file can actually observe the fire-and-forget POST it triggers.
process.env.DD_METRICS_API_KEY = 'test-dd-metrics-key';
process.env.DD_SITE = 'datadoghq.example.invalid';

const { embed, embedBatch, chat } = await import('./foundry.js');

interface CapturedDdCall {
  url: string;
  body: { series: Array<{ metric: string; type: number; points: Array<{ value: number }>; tags: string[] }> };
}

/** Routes by URL: api.openai.com gets the caller-supplied canned response; the Datadog series
 *  endpoint is captured into `ddCalls` and acknowledged with 202. Any other URL fails the test
 *  loudly (a wiring bug should never quietly hit some THIRD unexpected endpoint). */
function stubFetch(ddCalls: CapturedDdCall[], openaiResponse: unknown) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    // Route on the PARSED hostname/path, not a substring of the raw string (CodeQL
    // js/incomplete-url-substring-sanitization): a stub that matched 'api.openai.com' anywhere
    // in the URL would also accept e.g. https://evil.example/?next=api.openai.com.
    const parsed = new URL(u);
    if (parsed.hostname === 'api.openai.com') {
      return new Response(JSON.stringify(openaiResponse), { status: 200 });
    }
    if (parsed.pathname.endsWith('/api/v2/series')) {
      ddCalls.push({ url: u, body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 202 });
    }
    throw new Error(`unexpected fetch to ${u} -- this test only expects api.openai.com and the Datadog series endpoint`);
  }) as unknown as typeof fetch;
}

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function pointsNamed(calls: CapturedDdCall[], metric: string) {
  return calls.flatMap((c) => c.body.series).filter((s) => s.metric === metric);
}

test('embed(): a real OpenAI embeddings call with a usage object reaches the Datadog series endpoint tagged kind:embedding', async () => {
  const ddCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(ddCalls, { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 42, total_tokens: 42 } }),
    () => embed('hello world'),
  );
  const tokenPoints = pointsNamed(ddCalls, 'otc.fleet.openai.tokens');
  const inputPoint = tokenPoints.find((p) => p.tags.includes('direction:input'));
  assert.ok(inputPoint, 'expected an otc.fleet.openai.tokens{direction:input} point');
  assert.equal(inputPoint!.points[0].value, 42);
  assert.ok(inputPoint!.tags.includes('kind:embedding'));
  assert.ok(inputPoint!.tags.includes('model:text-embedding-3-large'));
  assert.ok(inputPoint!.tags.includes('repo:otchealth-mcp-server'));
  const costPoints = pointsNamed(ddCalls, 'otc.fleet.openai.cost_usd_est');
  assert.equal(costPoints.length, 1);
  assert.ok(costPoints[0].points[0].value > 0);
});

test('embed(): missing usage in the response records zero tokens rather than throwing or dropping the call', async () => {
  const ddCalls: CapturedDdCall[] = [];
  await assert.doesNotReject(() =>
    withStubbedFetch(stubFetch(ddCalls, { data: [{ embedding: [0.1] }] }), () => embed('no usage field here')),
  );
  const requestPoints = pointsNamed(ddCalls, 'otc.fleet.openai.requests');
  assert.equal(requestPoints.length, 1, 'a request point is still emitted even with prompt_tokens=0 (always emitted unconditionally)');
});

test('embedBatch(): one recorded usage event covers the WHOLE batch, not one per input text', async () => {
  const ddCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(ddCalls, { data: [{ embedding: [1], index: 0 }, { embedding: [2], index: 1 }, { embedding: [3], index: 2 }], usage: { prompt_tokens: 9, total_tokens: 9 } }),
    () => embedBatch(['a', 'b', 'c']),
  );
  const requestPoints = pointsNamed(ddCalls, 'otc.fleet.openai.requests');
  assert.equal(requestPoints.length, 1);
  assert.equal(requestPoints[0].points[0].value, 1, 'ONE request recorded for the whole batch call, matching the single real HTTP call made');
});

test('embedBatch(): an empty input list makes no network call at all, so no usage is ever recorded', async () => {
  const ddCalls: CapturedDdCall[] = [];
  const result = await withStubbedFetch(
    stubFetch(ddCalls, { data: [] }),
    () => embedBatch([]),
  );
  assert.deepEqual(result, []);
  assert.equal(ddCalls.length, 0);
});

test('chat(): a real OpenAI chat completion with usage (incl. cached tokens) reaches Datadog tagged kind:chat, model from the API echo', async () => {
  const ddCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(ddCalls, {
      choices: [{ message: { content: 'hi there' } }],
      model: 'gpt-4o-2026-01-01',
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    }),
    () => chat([{ role: 'user', content: 'hello' }]),
  );
  const tokenPoints = pointsNamed(ddCalls, 'otc.fleet.openai.tokens');
  const inputPoint = tokenPoints.find((p) => p.tags.includes('direction:input'));
  const outputPoint = tokenPoints.find((p) => p.tags.includes('direction:output'));
  assert.equal(inputPoint?.points[0].value, 100);
  assert.equal(outputPoint?.points[0].value, 20);
  assert.ok(inputPoint?.tags.includes('model:gpt-4o-2026-01-01'), 'uses the model the API echoed back, not just the requested tier');
  assert.ok(inputPoint?.tags.includes('kind:chat'));
  assert.ok(inputPoint?.tags.includes('caller:gateway-chat'));
  // gpt-4o-2026-01-01 is a dated snapshot of a KNOWN family (gpt-4o), so this must NOT be tagged
  // unknown even though the exact dated string is not literally in the price table's rule list --
  // matches the toolkit's identical dated-snapshot regex behavior.
  assert.ok(inputPoint?.tags.includes('unknown:false'));
});

test('chat(): the cost estimate reflects the cheaper cached-token rate when prompt_tokens_details.cached_tokens is present', async () => {
  const noCacheCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(noCacheCalls, { choices: [{ message: { content: 'x' } }], model: 'gpt-4o', usage: { prompt_tokens: 1000, completion_tokens: 0 } }),
    () => chat([{ role: 'user', content: 'a' }]),
  );
  const cachedCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(cachedCalls, { choices: [{ message: { content: 'x' } }], model: 'gpt-4o', usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } } }),
    () => chat([{ role: 'user', content: 'b' }]),
  );
  const noCacheCost = pointsNamed(noCacheCalls, 'otc.fleet.openai.cost_usd_est')[0].points[0].value;
  const cachedCost = pointsNamed(cachedCalls, 'otc.fleet.openai.cost_usd_est')[0].points[0].value;
  assert.ok(cachedCost < noCacheCost, 'an all-cached-prompt call must cost less than an all-fresh one of the same size');
});

test('a model this table does not confidently know the price of is tagged unknown:true, never silently absorbed into a known family', async () => {
  const ddCalls: CapturedDdCall[] = [];
  await withStubbedFetch(
    stubFetch(ddCalls, { choices: [{ message: { content: 'x' } }], model: 'gpt-5.6-luna', usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    () => chat([{ role: 'user', content: 'x' }]),
  );
  const tokenPoint = pointsNamed(ddCalls, 'otc.fleet.openai.tokens')[0];
  assert.ok(tokenPoint.tags.includes('unknown:true'));
});
