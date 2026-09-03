import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOpenAICostUsd } from '../telemetry/openai-cost.js';

// Pinning the MONEY consequence of "the echo wins", not just the string plumbing: a flex request
// that OpenAI actually served at 'default' must be priced at FULL rate. The earlier OR form
// resolved that case to 'flex' and halved the recorded cost, under-reporting real spend silently.
test('a flex request served at default is priced at full rate, not half', () => {
  const args = {
    model: 'gpt-5.6-terra',
    kind: 'chat' as const,
    promptTokens: 100000,
    completionTokens: 10000,
    cachedTokens: 0,
  };
  const full = estimateOpenAICostUsd({ ...args });
  const served_default = estimateOpenAICostUsd({ ...args, serviceTier: 'default' });
  const served_flex = estimateOpenAICostUsd({ ...args, serviceTier: 'flex' });
  assert.equal(served_default.costUsd, full.costUsd, 'serviceTier default must cost the same as unset');
  assert.ok(served_flex.costUsd > 0, 'flex cost must be a real number, not zero');
  assert.equal(served_flex.costUsd, full.costUsd * 0.5, 'flex is exactly half of list');
  assert.notEqual(served_default.costUsd, served_flex.costUsd, 'default and flex must not price identically');
});
