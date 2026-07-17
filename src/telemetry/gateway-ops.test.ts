import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapturePayload, summarizeUsage, overSoftBudget, buildLatencyFields } from './gateway-ops.js';

test('summarizeUsage: surfaces cached_tokens + cached_pct from prompt_tokens_details', () => {
  const s = summarizeUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 800 } });
  assert.equal(s.prompt_tokens, 1000);
  assert.equal(s.completion_tokens, 200);
  assert.equal(s.cached_tokens, 800);
  assert.equal(s.total_tokens, 1200);
  assert.equal(s.cached_pct, 80);
});

test('summarizeUsage: tolerant of missing/partial usage (no cache, no total)', () => {
  const s = summarizeUsage({ prompt_tokens: 500, completion_tokens: 100 });
  assert.equal(s.cached_tokens, 0);
  assert.equal(s.cached_pct, 0);
  assert.equal(s.total_tokens, 600, 'total falls back to prompt+completion');
  assert.deepEqual(summarizeUsage(null), { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, total_tokens: 0, cached_pct: 0 });
});

test('overSoftBudget: flags an oversized single call, not a normal one', () => {
  assert.equal(overSoftBudget(summarizeUsage({ prompt_tokens: 1000, completion_tokens: 200 })), false);
  assert.equal(overSoftBudget({ prompt_tokens: 90000, completion_tokens: 5000, cached_tokens: 0, total_tokens: 95000, cached_pct: 0 }), true);
  assert.equal(overSoftBudget(summarizeUsage({ prompt_tokens: 100, completion_tokens: 50 }), 120), true);
});

test('buildCapturePayload: returns null when no key (telemetry inert / disabled)', () => {
  assert.equal(buildCapturePayload('gateway_llm_call', { a: 1 }, 'd', ''), null);
});

test('buildCapturePayload: builds a well-formed capture body when a key is present', () => {
  const p = buildCapturePayload('gateway_llm_call', { model: 'gpt-5.1' }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.api_key, 'phc_test');
  assert.equal(p!.event, 'gateway_llm_call');
  assert.equal(p!.distinct_id, 'cto');
  assert.equal(p!.properties.source, 'otchealth-mcp-server');
  assert.equal(p!.properties.model, 'gpt-5.1');
  assert.ok(typeof p!.timestamp === 'string' && p!.timestamp.length > 0);
});

test('buildCapturePayload: distinct_id defaults to "gateway" when omitted', () => {
  const p = buildCapturePayload('gateway_governance_would_deny', {}, undefined, 'phc_x');
  assert.equal(p!.distinct_id, 'gateway');
});

// Phase 2 SLO telemetry emits (gw_mutation / gw_checkpoint / gw_doctrine_surfaced), wired into
// tools/registry.ts (gw_mutation, gw_doctrine_surfaced) and tools/memory/checkpoint.ts
// (gw_checkpoint), all via captureGatewayEvent -> buildCapturePayload -- the same pure helper
// exercised above. These tests lock in the event NAMES and property SHAPES so a future refactor
// cannot silently rename or reshape the fields the capture-rate (gw_checkpoint / gw_mutation) and
// doctrine-coverage (gw_doctrine_surfaced) SLOs are computed from. The network fire-and-forget
// itself is out of scope here (captureGatewayEvent's own contract, already inert-by-default per the
// tests above).

test('Phase 2 SLO: gw_mutation payload shape (capture-rate denominator)', () => {
  const p = buildCapturePayload('gw_mutation', { tool: 'checkpoint', journaled: true }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.event, 'gw_mutation');
  assert.equal(p!.distinct_id, 'cto');
  assert.equal(p!.properties.tool, 'checkpoint');
  assert.equal(p!.properties.journaled, true);
});

test('Phase 2 SLO: gw_checkpoint payload shape (capture-rate numerator)', () => {
  const p = buildCapturePayload('gw_checkpoint', { agent: 'cto', written: 2, distilled: 1 }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.event, 'gw_checkpoint');
  assert.equal(p!.distinct_id, 'cto');
  assert.equal(p!.properties.agent, 'cto');
  assert.equal(p!.properties.written, 2);
  assert.equal(p!.properties.distilled, 1);
});

test('Phase 2 SLO: gw_doctrine_surfaced payload shape (doctrine-coverage)', () => {
  const p = buildCapturePayload('gw_doctrine_surfaced', { tool: 'posthog_query_hogql', pitfalls: 2 }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.event, 'gw_doctrine_surfaced');
  assert.equal(p!.distinct_id, 'cto');
  assert.equal(p!.properties.tool, 'posthog_query_hogql');
  assert.equal(p!.properties.pitfalls, 2);
});

test('Phase 2 SLO: all three emits stay inert (null payload) with no PostHog key configured', () => {
  assert.equal(buildCapturePayload('gw_mutation', { tool: 'x', journaled: false }, 'cto', ''), null);
  assert.equal(buildCapturePayload('gw_checkpoint', { agent: 'cto', written: 0, distilled: 0 }, 'cto', ''), null);
  assert.equal(buildCapturePayload('gw_doctrine_surfaced', { tool: 'x', pitfalls: 1 }, 'cto', ''), null);
});

// W1-6 SPEED INSTRUMENTATION: buildLatencyFields is the pure shape-builder wired into the
// gateway_llm_call / gateway_llm_cache_hit emits in tools/llm/azure.ts, so p95 latency is visible
// per model/cache_hit/latency_class in PostHog. No Date.now() and no network inside the helper
// itself -- start/end are caller-supplied -- so every case below is provable without a real clock.

test('buildLatencyFields: computes wall-clock duration_ms from caller-supplied start/end and passes through model/cache fields', () => {
  const f = buildLatencyFields({ startedAt: 1000, endedAt: 1250, model: 'gpt-5.1', cacheHit: false, cachedPct: 40 });
  assert.equal(f.duration_ms, 250);
  assert.equal(f.cache_hit, false);
  assert.equal(f.cached_pct, 40);
  assert.equal(f.model, 'gpt-5.1');
  assert.equal(f.latency_class, 'normal', 'defaults to normal when the caller does not tag a class');
  assert.equal('ttft_ms' in f, false, 'ttft_ms is omitted (never faked) when not genuinely measured');
});

test('buildLatencyFields: latency_class is caller-passed, never invented', () => {
  const hot = buildLatencyFields({ startedAt: 0, endedAt: 10, model: 'm', cacheHit: true, latencyClass: 'hot' });
  assert.equal(hot.latency_class, 'hot');
  const bg = buildLatencyFields({ startedAt: 0, endedAt: 10, model: 'm', cacheHit: false, latencyClass: 'background' });
  assert.equal(bg.latency_class, 'background');
});

test('buildLatencyFields: ttft_ms is included only when the caller genuinely measured it (streaming)', () => {
  const withTtft = buildLatencyFields({ startedAt: 0, endedAt: 500, model: 'm', cacheHit: false, ttftMs: 120 });
  assert.equal(withTtft.ttft_ms, 120);
  const withoutTtft = buildLatencyFields({ startedAt: 0, endedAt: 500, model: 'm', cacheHit: false });
  assert.equal(withoutTtft.ttft_ms, undefined);
  const nonFinite = buildLatencyFields({ startedAt: 0, endedAt: 500, model: 'm', cacheHit: false, ttftMs: NaN });
  assert.equal(nonFinite.ttft_ms, undefined, 'a non-finite ttftMs is dropped, not passed through as junk');
});

test('buildLatencyFields: cachedPct defaults to 0 when the caller has no usage to derive it from (e.g. a cache-served call)', () => {
  const f = buildLatencyFields({ startedAt: 0, endedAt: 5, model: 'm', cacheHit: true });
  assert.equal(f.cached_pct, 0);
});

test('buildLatencyFields: duration_ms never goes negative on a clock anomaly', () => {
  const f = buildLatencyFields({ startedAt: 500, endedAt: 100, model: 'm', cacheHit: false });
  assert.equal(f.duration_ms, 0);
});

test('W1-6: the full latency+cache shape survives buildCapturePayload unchanged (the real gateway_llm_call emit path)', () => {
  const latency = buildLatencyFields({
    startedAt: 1000,
    endedAt: 1180,
    model: 'gpt-5.1',
    cacheHit: false,
    cachedPct: 62.5,
    latencyClass: 'normal',
  });
  const p = buildCapturePayload('gateway_llm_call', { task: 'summarize', tier: 'standard', ...latency }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.properties.duration_ms, 180);
  assert.equal(p!.properties.cache_hit, false);
  assert.equal(p!.properties.cached_pct, 62.5);
  assert.equal(p!.properties.model, 'gpt-5.1');
  assert.equal(p!.properties.latency_class, 'normal');
});

test('W1-6: a cache-served response reports cache_hit true with the same shape, so p95 is sliceable by cache_hit', () => {
  const latency = buildLatencyFields({ startedAt: 1000, endedAt: 1020, model: 'gpt-5.1', cacheHit: true, cachedPct: 100, latencyClass: 'hot' });
  const p = buildCapturePayload('gateway_llm_cache_hit', { task: 'classify', tier: 'standard', ...latency }, 'cto', 'phc_test');
  assert.ok(p);
  assert.equal(p!.properties.duration_ms, 20);
  assert.equal(p!.properties.cache_hit, true);
  assert.equal(p!.properties.latency_class, 'hot');
});
