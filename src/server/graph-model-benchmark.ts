import { createHash } from 'node:crypto';

/** Pure synthetic quality benchmark for graph extraction candidates. No provider calls. */
export type Assertion = Readonly<{ id: string; subject: string; predicate: string; object: string; citations: string[]; causation?: boolean }>;
export type Candidate = Readonly<{ subject: string; predicate: string; object: string; citations: string[]; causation?: boolean }>;
export type ModelRun = Readonly<{ provider: string; model: string; candidates: Candidate[]; elapsed_ms: number; attempts: number }>;
export type Score = Readonly<{ assertion_count: number; input_valid: boolean; invalid_assertion_count: number; invalid_candidate_count: number; precision: number; recall: number; citation_validity: number; false_merges: number; unsupported_causation: number; missing_expected_causation: number; elapsed_ms: number; attempts: number }>;
export type SubscriptionModel = Readonly<{ provider: string; model: string; extractor_version: string; extractor_bundle_sha256: string }>;
export type SyntheticRunPlan = Readonly<{
  schema: 'graph-model-benchmark-run-v1';
  synthetic_only: true;
  input_sha256: string;
  provider: string;
  model: string;
  extractor_version: string;
  extractor_bundle_sha256: string;
  billing_route: 'chatgpt_subscription';
  paid_fallback: false;
  max_attempts: 2;
  idempotency_key: string;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const key = (x: { subject: string; predicate: string; object: string }) => `${x.subject}\u0000${x.predicate}\u0000${x.object}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validCitations = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonBlank);
const validAssertion = (value: unknown): value is Assertion => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return nonBlank(row.id) && nonBlank(row.subject) && nonBlank(row.predicate) && nonBlank(row.object) && validCitations(row.citations) &&
    (row.causation === undefined || typeof row.causation === 'boolean');
};
const validCandidate = (value: unknown): value is Candidate => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return nonBlank(row.subject) && nonBlank(row.predicate) && nonBlank(row.object) && validCitations(row.citations) &&
    (row.causation === undefined || typeof row.causation === 'boolean');
};

/** Scores independently recorded candidates. A duplicate candidate cannot inflate recall. */
export function scoreGraphRun(assertions: Assertion[], run: ModelRun): Score {
  const truth = new Map<string, Assertion>();
  const assertionIds = new Set<string>();
  let invalidAssertions = 0;
  for (const assertion of assertions) {
    const assertionKey = validAssertion(assertion) ? key(assertion) : '';
    if (!validAssertion(assertion) || assertionIds.has(assertion.id) || truth.has(assertionKey)) { invalidAssertions++; continue; }
    assertionIds.add(assertion.id);
    truth.set(assertionKey, assertion);
  }
  const matched = new Set<string>();
  let citations = 0;
  let merges = 0;
  let causation = 0;
  let missingExpectedCausation = 0;
  let invalidCandidates = 0;
  for (const candidate of run.candidates) {
    if (!validCandidate(candidate)) { invalidCandidates++; continue; }
    const candidateKey = key(candidate);
    const expected = truth.get(candidateKey);
    if (!expected) {
      merges++;
      if (candidate.causation === true) causation++;
      continue;
    }
    if (candidate.causation === true && expected.causation !== true) { causation++; continue; }
    if (expected.causation === true && candidate.causation !== true) { missingExpectedCausation++; continue; }
    matched.add(candidateKey);
    if (candidate.citations.length > 0 && candidate.citations.every((id) => expected.citations.includes(id))) citations++;
  }
  return {
    assertion_count: assertions.length,
    input_valid: invalidAssertions === 0 && invalidCandidates === 0,
    invalid_assertion_count: invalidAssertions,
    invalid_candidate_count: invalidCandidates,
    precision: run.candidates.length ? matched.size / run.candidates.length : 1,
    recall: assertions.length ? matched.size / assertions.length : 1,
    citation_validity: run.candidates.length ? citations / run.candidates.length : 1,
    false_merges: merges,
    unsupported_causation: causation,
    missing_expected_causation: missingExpectedCausation,
    elapsed_ms: run.elapsed_ms,
    attempts: run.attempts,
  };
}

export function qualityGate(score: Score): boolean {
  return score.assertion_count > 0 && score.input_valid && score.invalid_assertion_count === 0 && score.invalid_candidate_count === 0 && score.precision >= .95 && score.recall >= .9 && score.citation_validity >= .98 &&
    score.false_merges === 0 && score.unsupported_causation === 0 && score.missing_expected_causation === 0 && Number.isInteger(score.attempts) &&
    score.attempts >= 1 && score.attempts <= 2 && Number.isFinite(score.elapsed_ms) && score.elapsed_ms >= 0;
}

/**
 * Creates separate immutable, synthetic-only plans. A distinct model creates a
 * distinct idempotency key, so recorded output for one model cannot satisfy another.
 */
export function createSyntheticSubscriptionPlans(inputSha256: string, models: readonly SubscriptionModel[]): readonly SyntheticRunPlan[] {
  if (!SHA256.test(inputSha256) || models.length === 0) throw new Error('invalid_benchmark_input');
  const identities = new Set<string>();
  return models.map((model) => {
    if (!model.provider || !model.model || !model.extractor_version || !SHA256.test(model.extractor_bundle_sha256)) {
      throw new Error('invalid_benchmark_model');
    }
    const identity = `${model.provider}\u0000${model.model}`;
    if (identities.has(identity)) throw new Error('duplicate_benchmark_model');
    identities.add(identity);
    return Object.freeze({
      schema: 'graph-model-benchmark-run-v1' as const,
      synthetic_only: true as const,
      input_sha256: inputSha256,
      provider: model.provider,
      model: model.model,
      extractor_version: model.extractor_version,
      extractor_bundle_sha256: model.extractor_bundle_sha256,
      billing_route: 'chatgpt_subscription' as const,
      paid_fallback: false as const,
      max_attempts: 2 as const,
      idempotency_key: digest(`graph-model-benchmark-v1\u0000${inputSha256}\u0000${identity}\u0000${model.extractor_version}\u0000${model.extractor_bundle_sha256}`),
    });
  });
}

export function benchmarkManifest(assertions: Assertion[], runs: ModelRun[]) {
  return {
    schema: 'graph-model-benchmark-v1',
    assertions: assertions.length,
    runs: runs.map((run) => {
      const score = scoreGraphRun(assertions, run);
      return { reported_provider: run.provider, reported_model: run.model, model_identity: 'unverified_synthetic', score, quality_gate: qualityGate(score) };
    }),
  };
}