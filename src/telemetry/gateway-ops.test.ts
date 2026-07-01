import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapturePayload } from './gateway-ops.js';

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
