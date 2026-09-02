import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOpenAICostUsd } from './openai-cost.js';

test('estimateOpenAICostUsd: known chat model (gpt-4o) prices input+output at the published per-1M rate', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({
    model: 'gpt-4o',
    kind: 'chat',
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    cachedTokens: 0,
  });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 12.5) < 1e-9, `expected ~$12.50 (2.50 in + 10.00 out), got ${costUsd}`);
});

test('estimateOpenAICostUsd: cached prompt tokens price at the cheaper cached-input rate, not the fresh rate', () => {
  const allFresh = estimateOpenAICostUsd({ model: 'gpt-4o', kind: 'chat', promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 });
  const allCached = estimateOpenAICostUsd({ model: 'gpt-4o', kind: 'chat', promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 });
  assert.ok(allCached.costUsd < allFresh.costUsd);
  assert.ok(Math.abs(allCached.costUsd - 1.25) < 1e-9, `expected the $1.25/1M cached rate, got ${allCached.costUsd}`);
});

test('estimateOpenAICostUsd: known embedding model (text-embedding-3-large) prices at its published per-1M rate', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({
    model: 'text-embedding-3-large',
    kind: 'embedding',
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 0,
  });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 0.13) < 1e-9);
});

test('estimateOpenAICostUsd: an unrecognized chat model falls through to unknown_model, priced at the MOST expensive known chat family', () => {
  const unknownModel = estimateOpenAICostUsd({ model: 'gpt-5.6-luna', kind: 'chat', promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 });
  const knownGpt4o = estimateOpenAICostUsd({ model: 'gpt-4o', kind: 'chat', promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 });
  assert.equal(unknownModel.unknown, true);
  assert.ok(unknownModel.costUsd >= knownGpt4o.costUsd, 'the unknown bucket must never under-count relative to the most expensive KNOWN family');
});

test('estimateOpenAICostUsd: an unrecognized embedding model falls through to unknown_model, priced at the most expensive known embedding family', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({ model: 'text-embedding-4-giant', kind: 'embedding', promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 0 });
  assert.equal(unknown, true);
  assert.ok(Math.abs(costUsd - 0.13) < 1e-9);
});

test('estimateOpenAICostUsd: negative/garbage token counts never go negative or throw', () => {
  assert.doesNotThrow(() => {
    const { costUsd } = estimateOpenAICostUsd({ model: 'gpt-4o', kind: 'chat', promptTokens: -5, completionTokens: -5, cachedTokens: -5 });
    assert.ok(costUsd >= 0);
  });
});
