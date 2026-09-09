import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkManifest, createSyntheticSubscriptionPlans, qualityGate, scoreGraphRun } from './graph-model-benchmark.js';

const SHA = 'a'.repeat(64);
const assertions = [{ id: 'a', subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] }];

test('scores independent verifier dimensions and rejects false causation', () => {
  const good = scoreGraphRun(assertions, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [{ subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] }] });
  assert.equal(qualityGate(good), true);
  const bad = scoreGraphRun(assertions, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [{ subject: 'x', predicate: 'causes', object: 'y', citations: ['bad'], causation: true }] });
  assert.equal(bad.false_merges, 1);
  assert.equal(bad.unsupported_causation, 1);
  assert.equal(qualityGate(bad), false);
  const manifest = benchmarkManifest(assertions, [{ provider: 'p', model: 'm', elapsed_ms: 1, attempts: 1, candidates: [] }]);
  assert.equal(manifest.schema, 'graph-model-benchmark-v1');
  assert.equal(manifest.runs[0].model_identity, 'unverified_synthetic');
});

test('duplicate candidates cannot inflate recall or precision', () => {
  const score = scoreGraphRun(assertions, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [
    { subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] },
    { subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] },
  ] });
  assert.equal(score.recall, 1);
  assert.equal(score.precision, .5);
  assert.equal(qualityGate(score), false);
});

test('plans isolate synthetic subscription model runs and reject duplicate identities', () => {
  const plans = createSyntheticSubscriptionPlans(SHA, [
    { provider: 'codex-chatgpt-subscription-review', model: 'gpt-5.6-luna', extractor_version: 'provider-v1', extractor_bundle_sha256: 'b'.repeat(64) },
    { provider: 'codex-chatgpt-subscription-review', model: 'gpt-5.6-sol', extractor_version: 'provider-v1', extractor_bundle_sha256: 'c'.repeat(64) },
  ]);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].paid_fallback, false);
  assert.equal(plans[0].billing_route, 'chatgpt_subscription');
  assert.notEqual(plans[0].idempotency_key, plans[1].idempotency_key);
  assert.throws(() => createSyntheticSubscriptionPlans(SHA, [
    { provider: 'p', model: 'm', extractor_version: 'v', extractor_bundle_sha256: 'd'.repeat(64) },
    { provider: 'p', model: 'm', extractor_version: 'v', extractor_bundle_sha256: 'e'.repeat(64) },
  ]), /duplicate_benchmark_model/);
});
test('fails closed for empty truth sets and invalid run telemetry', () => {
  const empty = scoreGraphRun([], { provider: 'subscription', model: 'test', elapsed_ms: 0, attempts: 1, candidates: [] });
  assert.equal(empty.assertion_count, 0);
  assert.equal(qualityGate(empty), false);
  const invalidAttempts = scoreGraphRun(assertions, { provider: 'subscription', model: 'test', elapsed_ms: -1, attempts: -100, candidates: [{ subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] }] });
  assert.equal(qualityGate(invalidAttempts), false);
});
test('one repeated truth cannot mask a missing second assertion', () => {
  const twoAssertions = [
    ...assertions,
    { id: 'b', subject: 'y', predicate: 'owns', object: 'z', citations: ['c2'] },
  ];
  const score = scoreGraphRun(twoAssertions, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [
    { subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] },
    { subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] },
  ] });
  assert.equal(score.recall, .5);
  assert.equal(score.precision, .5);
  assert.equal(qualityGate(score), false);
});

test('rejects nonfinite timing telemetry', () => {
  const score = scoreGraphRun(assertions, { provider: 'subscription', model: 'test', elapsed_ms: Number.POSITIVE_INFINITY, attempts: 1, candidates: [{ subject: 'x', predicate: 'owns', object: 'y', citations: ['c1'] }] });
  assert.equal(qualityGate(score), false);
});

test('fails closed when expected causation is omitted by a candidate', () => {
  const causalTruth = [{ id: 'causal', subject: 'x', predicate: 'causes', object: 'y', citations: ['c1'], causation: true }];
  const score = scoreGraphRun(causalTruth, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [{ subject: 'x', predicate: 'causes', object: 'y', citations: ['c1'] }] });
  assert.equal(score.missing_expected_causation, 1);
  assert.equal(score.recall, 0);
  assert.equal(qualityGate(score), false);
});

test('extractor changes cannot reuse a synthetic operation identity', () => {
  const one = createSyntheticSubscriptionPlans(SHA, [{ provider: 'p', model: 'm', extractor_version: 'v1', extractor_bundle_sha256: 'b'.repeat(64) }]);
  const two = createSyntheticSubscriptionPlans(SHA, [{ provider: 'p', model: 'm', extractor_version: 'v2', extractor_bundle_sha256: 'c'.repeat(64) }]);
  assert.notEqual(one[0].idempotency_key, two[0].idempotency_key);
});

test('rejects malformed and duplicate assertions or candidates', () => {
  const blankAssertion = [{ id: ' ', subject: ' ', predicate: ' ', object: ' ', citations: [''] }];
  const blankScore = scoreGraphRun(blankAssertion, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: [{ subject: ' ', predicate: ' ', object: ' ', citations: [''] }] });
  assert.equal(blankScore.input_valid, false);
  assert.equal(blankScore.invalid_assertion_count, 1);
  assert.equal(blankScore.invalid_candidate_count, 1);
  assert.equal(qualityGate(blankScore), false);
  const duplicateTruth = Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`, subject: index === 9 ? 's-0' : `s-${index}`, predicate: 'p', object: index === 9 ? 'o-0' : `o-${index}`, citations: ['c'] }));
  const duplicateScore = scoreGraphRun(duplicateTruth, { provider: 'subscription', model: 'test', elapsed_ms: 1, attempts: 1, candidates: duplicateTruth.slice(0, 9).map(({ subject, predicate, object, citations }) => ({ subject, predicate, object, citations })) });
  assert.equal(duplicateScore.input_valid, false);
  assert.equal(duplicateScore.invalid_assertion_count, 1);
  assert.equal(qualityGate(duplicateScore), false);
});
