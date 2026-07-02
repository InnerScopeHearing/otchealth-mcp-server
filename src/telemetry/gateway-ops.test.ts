import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapturePayload, summarizeUsage, overSoftBudget } from './gateway-ops.js';

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
