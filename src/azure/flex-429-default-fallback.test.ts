// Own file/process -- loadEnv() caches per process on first call, same convention as
// chat-provider.test.ts (this file's sibling for the OpenAI-direct chat path).
//
// Covers the flex-429 -> default-tier fallback in chat() (src/azure/foundry.ts): OpenAI's
// service_tier:'flex' is a shared best-effort capacity pool, live-verified 2026-09-03 to return
// HTTP 429 "Flex does not have sufficient resources available..." independent of any per-caller
// rate limit, while the SAME model with no service_tier succeeds. fetchWithBudget's own retry
// (util/fetch-budget.ts) re-sends the IDENTICAL body on a 429 and so cannot recover from this --
// chat() now detects the flex-capacity condition specifically and retries ONCE with service_tier
// stripped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
// Pin the pre-2026-08-28 backend defaults (env.ts's SEARCH_BACKEND/EMBEDDINGS_PROVIDER/
// LLM_PROVIDER/WEB_SEARCH_PROVIDER/BLOB_BACKEND/STATE_BACKEND now default to their AWS-native
// replacements) -- this file only cares about the OpenAI-direct chat path, so these are inert.
process.env.STATE_BACKEND ||= 'cosmos';
process.env.BLOB_BACKEND ||= 'azure';
process.env.SEARCH_BACKEND ||= 'azure';
process.env.LLM_PROVIDER ||= 'foundry';
process.env.EMBEDDINGS_PROVIDER ||= 'foundry';
process.env.WEB_SEARCH_PROVIDER ||= 'azure';
process.env.LLM_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://otchealth-foundry.example.invalid';
process.env.FOUNDRY_KEY = 'test-foundry-key';
// Datadog emission is otherwise a no-op without a key (datadog-metrics.ts's resolveDdCreds) -- set
// one here so the (d) cost-accounting tests can observe the fire-and-forget POST it triggers,
// mirroring foundry-openai-cost-wiring.test.ts.
process.env.DD_METRICS_API_KEY = 'test-dd-metrics-key';
process.env.DD_SITE = 'datadoghq.example.invalid';

const { chat, FoundryError, isFlexCapacityError } = await import('./foundry.js');
const { estimateOpenAICostUsd } = await import('../telemetry/openai-cost.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// The exact live-observed text (2026-09-03, gpt-5.6-luna). retry-after:0 keeps fetchWithBudget's
// own internal backoff from actually sleeping in these tests.
const FLEX_CAPACITY_MESSAGE =
  'Flex does not have sufficient resources available to fulfill your request. You can try again ' +
  'later in case more resources are available, or change service_tier=default.';
const GENERIC_RATE_LIMIT_MESSAGE =
  'Rate limit reached for gpt-5.6-terra in organization org-test on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s.';
const FALLBACK_FAILURE_MESSAGE = 'The server had an error while processing your request. Sorry about that!';

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'retry-after': '0' } });
}

/**
 * True only for api.openai.com. A SUCCESSFUL chat() call also fires a fire-and-forget cost/usage
 * POST to the Datadog series endpoint (recordOpenAIUsage -> emitOpenAIFleetMetrics -- see
 * telemetry/datadog-metrics.ts), which is live in this file because DD_METRICS_API_KEY/DD_SITE are
 * set above for the (d) cost-accounting tests. Every stub below must gate on this (mirroring
 * foundry-openai-cost-wiring.test.ts's identical routing) so that unrelated, uncounted metrics call
 * can never be mistaken for a second logical chat request -- exactly the trap that first made test
 * (a) below misreport 2 fallback attempts instead of 1.
 */
function isOpenAiChatCall(url: string): boolean {
  return new URL(url).hostname === 'api.openai.com';
}

// ---- isFlexCapacityError: the pure detector, tested in isolation from any network mocking ----

test('isFlexCapacityError: matches the live-observed flex-capacity 429 text', () => {
  assert.equal(isFlexCapacityError(429, FLEX_CAPACITY_MESSAGE), true);
});

test('isFlexCapacityError: matches a REWORDED flex-capacity message (keyword pair, not one exact sentence)', () => {
  assert.equal(isFlexCapacityError(429, 'The flex tier currently has insufficient capacity for this model.'), true);
  assert.equal(isFlexCapacityError(429, 'flex: no capacity, resources available shortly'), true);
});

test('isFlexCapacityError: a generic rate-limit 429 (no mention of flex at all) does not match', () => {
  assert.equal(isFlexCapacityError(429, GENERIC_RATE_LIMIT_MESSAGE), false);
});

test('isFlexCapacityError: "flex" alone, with no capacity/resource word, does not match', () => {
  assert.equal(isFlexCapacityError(429, 'The flex model deployment was renamed last week.'), false);
});

test('isFlexCapacityError: a capacity word alone, with no mention of flex, does not match', () => {
  assert.equal(isFlexCapacityError(429, 'Insufficient capacity for this request right now.'), false);
});

test('isFlexCapacityError: never matches a non-429 status, even with the exact flex-capacity text', () => {
  assert.equal(isFlexCapacityError(500, FLEX_CAPACITY_MESSAGE), false);
  assert.equal(isFlexCapacityError(400, FLEX_CAPACITY_MESSAGE), false);
});

// ---- (a) flex 429 -> falls back to no-service_tier -> succeeds ----

test('(a) a flex-capacity 429 falls back to ONE request with service_tier stripped, and that fallback succeeding is the final chat() result', async () => {
  const calls: Array<{ flex: boolean }> = [];
  const result = await withStubbedFetch(
    (async (u: string, init?: RequestInit) => {
      if (!isOpenAiChatCall(u)) return new Response('{}', { status: 202 }); // the fire-and-forget Datadog POST -- never a logical chat attempt
      const body = JSON.parse(String(init?.body));
      const flex = body.service_tier === 'flex';
      calls.push({ flex });
      if (flex) return errorResponse(FLEX_CAPACITY_MESSAGE, 429);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'answered at default' } }], model: 'gpt-5.6-terra', service_tier: 'default' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
    () => chat([{ role: 'user', content: 'x' }], { serviceTier: 'flex' }),
  );
  assert.equal(result.text, 'answered at default');
  assert.equal(result.model, 'gpt-5.6-terra');
  const flexCalls = calls.filter((c) => c.flex);
  const fallbackCalls = calls.filter((c) => !c.flex);
  assert.equal(flexCalls.length, 2, 'the flex leg exhausts its own fetchWithBudget retry budget (2 attempts) before falling back');
  assert.equal(fallbackCalls.length, 1, 'exactly ONE fallback (no-service_tier) attempt is made, succeeding on its first try here');
});

// ---- (b) generic non-flex 429 -> existing same-request retry, no tier stripping ----

test('(b) a GENERIC (non-flex-capacity) 429 on a flex request keeps today\'s identical-retry behavior -- service_tier is NEVER stripped', async () => {
  let calls = 0;
  let sawStrippedTier = false;
  await assert.rejects(
    () =>
      withStubbedFetch(
        (async (u: string, init?: RequestInit) => {
          if (!isOpenAiChatCall(u)) return new Response('{}', { status: 202 });
          calls++;
          const body = JSON.parse(String(init?.body));
          if (body.service_tier !== 'flex') sawStrippedTier = true;
          return errorResponse(GENERIC_RATE_LIMIT_MESSAGE, 429);
        }) as unknown as typeof fetch,
        () => chat([{ role: 'user', content: 'x' }], { serviceTier: 'flex' }),
      ),
    (err: unknown) => err instanceof FoundryError && err.status === 429 && err.message === GENERIC_RATE_LIMIT_MESSAGE,
  );
  assert.equal(calls, 2, 'fetchWithBudget default retry only: the original attempt + 1 identical retry, no fallback attempt added');
  assert.equal(sawStrippedTier, false, 'service_tier must never be stripped for a 429 that is not a flex-capacity error');
});

// ---- (c) flex 429 then fallback ALSO fails -> real error surfaced with real status ----

test("(c) when the fallback ALSO fails, the fallback's OWN real error/status surfaces -- never the original flex 429, never swallowed", async () => {
  let flexAttempts = 0;
  let fallbackAttempts = 0;
  await assert.rejects(
    () =>
      withStubbedFetch(
        (async (u: string, init?: RequestInit) => {
          if (!isOpenAiChatCall(u)) return new Response('{}', { status: 202 });
          const body = JSON.parse(String(init?.body));
          if (body.service_tier === 'flex') {
            flexAttempts++;
            return errorResponse(FLEX_CAPACITY_MESSAGE, 429);
          }
          fallbackAttempts++;
          return errorResponse(FALLBACK_FAILURE_MESSAGE, 500);
        }) as unknown as typeof fetch,
        () => chat([{ role: 'user', content: 'x' }], { serviceTier: 'flex' }),
      ),
    (err: unknown) => err instanceof FoundryError && err.status === 500 && err.message === FALLBACK_FAILURE_MESSAGE,
  );
  // WORST-CASE ATTEMPT COUNT, pinned here: fetchWithBudget's own 1-retry budget applies to EACH of
  // the two logical requests independently (see foundry.ts chat()'s own comment) -- 2 physical
  // attempts for the flex leg (both 429), then up to 2 more for the fallback leg (both 500, since
  // 5xx is retryable too) = 4 total. The fallback is never itself re-wrapped in a second
  // flex->default attempt.
  assert.equal(flexAttempts, 2, 'the flex leg gets its own fetchWithBudget retry budget (2 attempts)');
  assert.equal(fallbackAttempts, 2, "the fallback leg ALSO gets its own fetchWithBudget retry budget (2 attempts), proving the worst case is bounded at 4, not unbounded");
});

// ---- (d) cost accounting stays honest: a fallen-back call is priced at full rate, never flex ----

interface CapturedDdCall {
  body: { series: Array<{ metric: string; points: Array<{ value: number }>; tags: string[] }> };
}

function stubFlexThenFallback(ddCalls: CapturedDdCall[], fallbackEchoesTier: boolean): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const parsed = new URL(u);
    if (parsed.hostname === 'api.openai.com') {
      const body = JSON.parse(String(init?.body));
      if (body.service_tier === 'flex') return errorResponse(FLEX_CAPACITY_MESSAGE, 429);
      const resp: Record<string, unknown> = {
        choices: [{ message: { content: 'ok' } }],
        model: 'gpt-5.6-terra',
        usage: { prompt_tokens: 100000, completion_tokens: 10000 },
      };
      // Real OpenAI responses were observed to always echo service_tier during 2026-09-03
      // verification, but chat()'s cost accounting must be correct EVEN IF a future fallback
      // response omits the field -- that omission is the one case a naive implementation (falling
      // back to the ORIGINAL opts.serviceTier, 'flex', instead of resetting it) would silently
      // mis-price. Both branches are exercised below.
      if (fallbackEchoesTier) resp.service_tier = 'default';
      return new Response(JSON.stringify(resp), { status: 200 });
    }
    if (parsed.pathname.endsWith('/api/v2/series')) {
      ddCalls.push({ body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 202 });
    }
    throw new Error(`unexpected fetch to ${u} -- this test only expects api.openai.com and the Datadog series endpoint`);
  }) as unknown as typeof fetch;
}

function recordedCost(calls: CapturedDdCall[]): number | undefined {
  return calls
    .flatMap((c) => c.body.series)
    .find((s) => s.metric === 'otc.fleet.openai.cost_usd_est')
    ?.points[0]?.value;
}

for (const fallbackEchoesTier of [true, false]) {
  test(
    `(d, fallback response ${fallbackEchoesTier ? 'echoes service_tier=default' : 'OMITS service_tier entirely'}) ` +
      'a flex request that falls back to default is COSTED at full price, never the 50% flex discount',
    async () => {
      const ddCalls: CapturedDdCall[] = [];
      await withStubbedFetch(stubFlexThenFallback(ddCalls, fallbackEchoesTier), () =>
        chat([{ role: 'user', content: 'x' }], { serviceTier: 'flex' }),
      );
      const actual = recordedCost(ddCalls);
      const fullPrice = estimateOpenAICostUsd({
        model: 'gpt-5.6-terra',
        kind: 'chat',
        promptTokens: 100000,
        completionTokens: 10000,
        cachedTokens: 0,
      }).costUsd;
      const halfPrice = estimateOpenAICostUsd({
        model: 'gpt-5.6-terra',
        kind: 'chat',
        promptTokens: 100000,
        completionTokens: 10000,
        cachedTokens: 0,
        serviceTier: 'flex',
      }).costUsd;
      assert.ok(actual !== undefined, 'a cost point must have been recorded for the successful fallback call');
      assert.ok(fullPrice > 0 && halfPrice > 0 && halfPrice < fullPrice, 'sanity: the two reference prices must actually differ');
      assert.equal(actual, fullPrice, 'a fallen-back-to-default call must cost the SAME as a plain (never-flex) call');
      assert.notEqual(actual, halfPrice, 'a fallen-back-to-default call must NEVER be priced at the 50% flex discount');
    },
  );
}
