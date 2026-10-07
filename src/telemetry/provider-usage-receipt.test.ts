import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderUsageReceipt, currentProviderUsageContext, withProviderUsageStage } from './provider-usage-receipt.js';

const estimate = () => ({ costUsd: 0, unknown: false });

test('provider receipt allowlists fields and records actual zero as reported', () => {
  const receipt = buildProviderUsageReceipt({
    kind: 'chat', usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, prompt: 'do not copy' },
    returnedModel: 'gpt-5.6-luna', requestedModel: 'not-the-returned-model',
    context: { stage: 'planning', correlationId: 'corr-1', releaseId: 'a'.repeat(40) },
    estimate, priceTableVersion: '2026-09-03',
  });
  assert.equal(receipt.usage_state, 'reported');
  assert.equal(receipt.prompt_tokens, 0);
  assert.equal(receipt.completion_tokens, 0);
  assert.equal(receipt.returned_model, 'gpt-5.6-luna');
  assert.equal(receipt.cached_tokens, 0);
  assert.equal(receipt.estimate_model_source, 'returned');
  assert.equal('prompt' in receipt, false);
});

test('missing and malformed usage stay distinct; partial invalid values do not estimate', () => {
  const missing = buildProviderUsageReceipt({ kind: 'chat', usage: undefined, requestedModel: 'gpt-5.6-terra', estimate });
  assert.equal(missing.usage_state, 'missing');
  assert.equal('estimate' in missing, false);
  const absentCache = buildProviderUsageReceipt({ kind: 'chat', usage: { prompt_tokens: 2, completion_tokens: 1 }, estimate });
  assert.equal(absentCache.cached_tokens, undefined, 'a missing counter must not be fabricated as zero');
  const invalid = buildProviderUsageReceipt({ kind: 'chat', usage: { prompt_tokens: 5, completion_tokens: 'bad' }, requestedModel: 'gpt-5.6-terra', estimate });
  assert.equal(invalid.usage_state, 'invalid');
  assert.equal('estimated_cost_usd' in invalid, false);
  assert.equal(invalid.cached_tokens, undefined, 'invalid usage must not fabricate an absent cached counter');
  const invalidPrompt = buildProviderUsageReceipt({ kind: 'chat', usage: { prompt_tokens: -1, completion_tokens: 0 }, estimate });
  assert.equal(invalidPrompt.usage_state, 'invalid');
  assert.equal(invalidPrompt.cached_tokens, undefined, 'negative prompt count with absent cached count remains content-free');
});

test('returned model is optional; requested fallback is explicitly labeled and prices unknown separately', () => {
  const receipt = buildProviderUsageReceipt({
    kind: 'embedding', usage: { prompt_tokens: 7, total_tokens: 7 }, requestedModel: 'text-embedding-3-large',
    context: { stage: 'retrieval', correlationId: 'unsafe id', releaseId: 'bad' }, estimate: () => ({ costUsd: 0.000001, unknown: true }), priceTableVersion: '2026-09-03',
  });
  assert.equal(receipt.returned_model, undefined);
  assert.equal(receipt.estimate_model_source, 'requested_fallback');
  assert.equal(receipt.unknown_model_price, true);
  assert.equal(receipt.usage_state, 'reported');
  assert.equal(receipt.correlation_id, 'unknown');
  assert.equal(receipt.release_id, 'unknown');
});

test('stage is a closed enum and malformed cached counts invalidate the estimate', () => {
  const receipt = buildProviderUsageReceipt({
    kind: 'chat', usage: { prompt_tokens: 8, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } },
    context: { stage: 'caller-value' as never, correlationId: 'c1', releaseId: 'b'.repeat(40) }, estimate,
  });
  assert.equal(receipt.stage, 'unknown');
  assert.equal(receipt.usage_state, 'invalid');
  assert.equal('estimated_cost_usd' in receipt, false);
});

test('stage context is async-local under concurrent planning and synthesis', async () => {
  const [planning, synthesis] = await Promise.all([
    withProviderUsageStage('planning', async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return currentProviderUsageContext().stage; }),
    withProviderUsageStage('synthesis', async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return currentProviderUsageContext().stage; }),
  ]);
  assert.equal(planning, 'planning');
  assert.equal(synthesis, 'synthesis');
  assert.equal(currentProviderUsageContext().stage, 'unknown');
});


test('detached shadow work remains labeled shadow while foreground retrieval keeps its own scope', async () => {
  let shadowReceiptStage: string | undefined;
  const detached = withProviderUsageStage('shadow', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    shadowReceiptStage = buildProviderUsageReceipt({ kind: 'embedding', usage: { prompt_tokens: 2 } }).stage;
  });
  const foregroundStage = await withProviderUsageStage('retrieval', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    return buildProviderUsageReceipt({ kind: 'embedding', usage: { prompt_tokens: 3 } }).stage;
  });
  await detached;
  assert.equal(shadowReceiptStage, 'shadow');
  assert.equal(foregroundStage, 'retrieval');
});
