import { createHash } from 'node:crypto';

/**
 * Narrow validation for the immutable subscription relationship-review result.
 *
 * The graph worker owns authorization, source resolution, operation transitions,
 * and S3 transport.  This module only recognizes the one reviewed provider and
 * its exact output envelope.  It deliberately has no permissive provider or
 * output fallback.
 */
export const SUBSCRIPTION_REVIEW_PROVIDER = 'codex-chatgpt-subscription-review';
export const SUBSCRIPTION_REVIEW_EXTRACTOR_VERSION = 'codex-subscription-review-provider-v1';
// Exact reviewed provider source/version pairs. A source change cannot become
// usable merely by presenting a different hash in an operation or result.
export const REVIEWED_SUBSCRIPTION_REVIEW_PROVIDER_PAIRS = Object.freeze([
  Object.freeze({
    provider_source_sha256: '4e204c24fc2f70671a2a4f8896fbcd3b9e446c3917d7dd3934a783cf3a81c3f6',
    verifier_version: SUBSCRIPTION_REVIEW_EXTRACTOR_VERSION,
  }),
  Object.freeze({
    provider_source_sha256: '0b749a25a2ae439c13ede05014f9fbea080080399aa8e458f4396d732f634371',
    verifier_version: SUBSCRIPTION_REVIEW_EXTRACTOR_VERSION,
  }),
]);

const SHA = /^[a-f0-9]{64}$/;
const LOGIN_CONTRACT = 'codex-login-status-before-model-exec-v1';
const REVIEW_KEYS = [
  'evidence', 'object_index', 'polarity', 'predicate', 'qualifications',
  'reason_code', 'request_sha256', 'subject_index', 'verdict',
] as const;

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).sort().map((key) =>
    JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function subscriptionReviewBundlesForRequest(requestSha256: string): readonly string[] {
  if (!SHA.test(requestSha256)) return Object.freeze([]);
  return Object.freeze(REVIEWED_SUBSCRIPTION_REVIEW_PROVIDER_PAIRS.map((pair) => sha256(canonical({
    provider_source_sha256: pair.provider_source_sha256,
    request_sha256: requestSha256,
    verifier_version: pair.verifier_version,
  }))));
}

export function isSubscriptionReviewOperationSpec(spec: Record<string, unknown>, prepared: boolean): boolean {
  return prepared &&
    spec.provider === SUBSCRIPTION_REVIEW_PROVIDER &&
    spec.extractor_version === SUBSCRIPTION_REVIEW_EXTRACTOR_VERSION &&
    spec.model === 'gpt-5.6-luna' &&
    spec.login_before_model_contract === LOGIN_CONTRACT &&
    SHA.test(String(spec.extractor_bundle_sha256 ?? '')) &&
    !/^([a-f0-9])\1{63}$/.test(String(spec.extractor_bundle_sha256));
}

/** The review adapter only accepts a prepared, immutable source witness. */
export type SubscriptionReviewSourceProof = Readonly<{
  text: string;
  textSha256: string;
}>;

function validReview(value: unknown, source: SubscriptionReviewSourceProof): boolean {
  if (!exact(value, REVIEW_KEYS)) return false;
  const review = value;
  if (!SHA.test(String(review.request_sha256 ?? '')) ||
      !['supported', 'unsupported', 'uncertain'].includes(String(review.verdict)) ||
      review.subject_index !== 0 || review.object_index !== 1 ||
      !bounded(review.predicate, 1200) ||
      !['positive', 'negative'].includes(String(review.polarity)) ||
      !Array.isArray(review.qualifications) || review.qualifications.length > 40 ||
      !review.qualifications.every((entry) => bounded(entry, 1200)) ||
      !bounded(review.reason_code, 240) ||
      !exact(review.evidence, ['start_utf16', 'end_utf16', 'quote'])) return false;
  const evidence = review.evidence;
  const start = evidence.start_utf16;
  const end = evidence.end_utf16;
  return typeof start === 'number' && typeof end === 'number' &&
    Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    start >= 0 && end > start && end <= source.text.length &&
    bounded(evidence.quote, 4000) && source.text.slice(start, end) === evidence.quote;
}

/**
 * Validates the exact provider envelope after the graph broker has independently
 * resolved the source proof. The operation's immutable provider bundle must
 * match one reviewed provider/version pair and this exact `request_sha256`, so
 * a reply for one review request cannot persist or replay for another request.
 */
export function validSubscriptionReviewOutput(
  value: unknown, spec: Record<string, unknown>, source: SubscriptionReviewSourceProof | null,
): boolean {
  if (!source || !SHA.test(source.textSha256) || !exact(value, [
    'provider', 'model', 'billing_route', 'paid_fallback', 'source_sha256', 'candidates', 'review',
  ])) return false;
  return value.provider === SUBSCRIPTION_REVIEW_PROVIDER &&
    value.provider === spec.provider && value.model === 'gpt-5.6-luna' && value.model === spec.model &&
    value.billing_route === 'chatgpt_subscription' && value.paid_fallback === false &&
    value.source_sha256 === source.textSha256 && Array.isArray(value.candidates) &&
    value.candidates.length === 0 && validReview(value.review, source) &&
    subscriptionReviewBundlesForRequest(
      String((value.review as Record<string, unknown>).request_sha256),
    ).includes(String(spec.extractor_bundle_sha256));
}
