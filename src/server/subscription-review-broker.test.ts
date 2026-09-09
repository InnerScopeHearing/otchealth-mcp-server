import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  isSubscriptionReviewOperationSpec,
  subscriptionReviewBundleForRequest,
  validSubscriptionReviewOutput,
} from './subscription-review-broker.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const text = 'A-001 depends on ORG-001.';
const source = { text, textSha256: sha(text) };
const requestSha256 = sha('review request');
const spec = {
  provider: 'codex-chatgpt-subscription-review',
  extractor_version: 'codex-subscription-review-provider-v1',
  extractor_bundle_sha256: subscriptionReviewBundleForRequest(requestSha256)!,
  login_before_model_contract: 'codex-login-status-before-model-exec-v1',
  model: 'gpt-5.6-luna',
};
const output = {
  provider: 'codex-chatgpt-subscription-review', model: 'gpt-5.6-luna',
  billing_route: 'chatgpt_subscription', paid_fallback: false, source_sha256: source.textSha256,
  candidates: [], review: {
    request_sha256: requestSha256, verdict: 'supported', subject_index: 0, object_index: 1,
    predicate: 'depends_on', polarity: 'positive', qualifications: [],
    evidence: { start_utf16: 0, end_utf16: text.length, quote: text }, reason_code: 'synthetic',
  },
};

test('review provider requires its fixed identity and a prepared operation', () => {
  assert.equal(isSubscriptionReviewOperationSpec(spec, true), true);
  for (const changed of [
    { ...spec, provider: 'codex-chatgpt-subscription' },
    { ...spec, extractor_version: 'other' },
    { ...spec, model: 'gpt-5.6-sol' },
    { ...spec, extractor_bundle_sha256: 'a'.repeat(64) },
  ]) assert.equal(isSubscriptionReviewOperationSpec(changed, true), false);
  assert.equal(isSubscriptionReviewOperationSpec(spec, false), false);
});

test('review output is exact, source-bound, and has no candidate side channel', () => {
  assert.equal(validSubscriptionReviewOutput(output, spec, source), true);
  for (const changed of [
    { ...output, provider: 'other' },
    { ...output, source_sha256: sha('other') },
    { ...output, candidates: [{}] },
    { ...output, extra: true },
    { ...output, review: { ...output.review, request_sha256: sha('different request') } },
    { ...output, review: { ...output.review, evidence: { ...output.review.evidence, end_utf16: 2 } } },
  ]) assert.equal(validSubscriptionReviewOutput(changed, spec, source), false);
  assert.equal(validSubscriptionReviewOutput(output, spec, null), false);
});

test('actual provider negative and uncertain forms retain exact request and evidence bindings', () => {
  const negativeText = 'A-001 does not depend on ORG-001.';
  const negativeSource = { text: negativeText, textSha256: sha(negativeText) };
  const negativeRequest = sha('negative review request');
  const negativeSpec = { ...spec,
    extractor_bundle_sha256: subscriptionReviewBundleForRequest(negativeRequest)! };
  const negative = {
    ...output, source_sha256: negativeSource.textSha256,
    review: { ...output.review, request_sha256: negativeRequest, verdict: 'supported',
      polarity: 'negative', evidence: { start_utf16: 0, end_utf16: negativeText.length, quote: negativeText } },
  };
  assert.equal(validSubscriptionReviewOutput(negative, negativeSpec, negativeSource), true);
  const uncertain = {
    ...output, review: { ...output.review, verdict: 'uncertain', qualifications: ['source is conditional'] },
  };
  assert.equal(validSubscriptionReviewOutput(uncertain, spec, source), true);
});
