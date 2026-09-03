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

// NOTE: these three short-context tests deliberately use 100,000 prompt tokens, NOT the 1,000,000
// used elsewhere in this file for the non-context-tiered families -- 1,000,000 prompt tokens is
// itself ABOVE the gpt-5.6 family's 272,000-token long-context threshold, so asserting SHORT prices
// against it would be asserting the wrong tier's numbers (caught by this suite: see the long-context
// tests below, which cover that boundary directly).
test('estimateOpenAICostUsd: gpt-5.6-sol (quality tier) prices short-context input+output at the published per-1M rate', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({
    model: 'gpt-5.6-sol',
    kind: 'chat',
    promptTokens: 100_000,
    completionTokens: 100_000,
    cachedTokens: 0,
  });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 2.4) < 1e-9, `expected $2.40 (0.1M * 4.00 in + 0.1M * 20.00 out), got ${costUsd}`);
});

test('estimateOpenAICostUsd: gpt-5.6-terra (standard tier) prices short-context input+output at the published per-1M rate', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({
    model: 'gpt-5.6-terra',
    kind: 'chat',
    promptTokens: 100_000,
    completionTokens: 100_000,
    cachedTokens: 0,
  });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 1.4) < 1e-9, `expected $1.40 (0.1M * 2.00 in + 0.1M * 12.00 out), got ${costUsd}`);
});

test('estimateOpenAICostUsd: gpt-5.6-luna (cheap tier) prices short-context input+output at the published per-1M rate', () => {
  const { costUsd, unknown } = estimateOpenAICostUsd({
    model: 'gpt-5.6-luna',
    kind: 'chat',
    promptTokens: 100_000,
    completionTokens: 100_000,
    cachedTokens: 0,
  });
  assert.equal(unknown, false);
  assert.ok(Math.abs(costUsd - 0.14) < 1e-9, `expected $0.14 (0.1M * 0.20 in + 0.1M * 1.20 out), got ${costUsd}`);
});

test('estimateOpenAICostUsd: gpt-5.6 long-context pricing applies only STRICTLY ABOVE the 272,000 prompt-token threshold', () => {
  const atThreshold = estimateOpenAICostUsd({ model: 'gpt-5.6-sol', kind: 'chat', promptTokens: 272_000, completionTokens: 0, cachedTokens: 0 });
  const aboveThreshold = estimateOpenAICostUsd({ model: 'gpt-5.6-sol', kind: 'chat', promptTokens: 272_001, completionTokens: 0, cachedTokens: 0 });
  // Short-context input rate is $4.00/1M -> 272,000 tokens costs $1.088.
  assert.ok(Math.abs(atThreshold.costUsd - (272_000 / 1e6) * 4.0) < 1e-9, 'exactly at the threshold must still use SHORT pricing');
  // Long-context input rate is $8.00/1M -> one token past the threshold crosses into it.
  assert.ok(Math.abs(aboveThreshold.costUsd - (272_001 / 1e6) * 8.0) < 1e-9, 'one token past the threshold must use LONG pricing');
});

test('estimateOpenAICostUsd: gpt-5.6 long-context tier also swaps the CACHED input rate, not just fresh input and output', () => {
  const shortCached = estimateOpenAICostUsd({ model: 'gpt-5.6-terra', kind: 'chat', promptTokens: 200_000, completionTokens: 0, cachedTokens: 200_000 });
  const longCached = estimateOpenAICostUsd({ model: 'gpt-5.6-terra', kind: 'chat', promptTokens: 300_000, completionTokens: 0, cachedTokens: 300_000 });
  // Short cachedInput $0.20/1M * 200,000 tokens = $0.04; long cachedInput $0.40/1M * 300,000 = $0.12.
  assert.ok(Math.abs(shortCached.costUsd - 0.04) < 1e-9, `expected the short $0.20/1M cached rate, got ${shortCached.costUsd}`);
  assert.ok(Math.abs(longCached.costUsd - 0.12) < 1e-9, `expected the long $0.40/1M cached rate, got ${longCached.costUsd}`);
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
  // gpt-5.6-luna is now a KNOWN, explicitly-priced model (added 2026-09-03) -- do not reuse it (or
  // -terra/-sol) as a "still unknown" example. gpt-9.9-unreleased stands in as a genuinely
  // unmatched, hypothetical future model name.
  const unknownModel = estimateOpenAICostUsd({ model: 'gpt-9.9-unreleased', kind: 'chat', promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 });
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
