import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaimsCompletion } from './claims-completion.ts';

const cleanReview = {
  verdict: 'pass',
  risk: 4,
  violations: [],
  compliant_rewrite: 'A personal sound amplifier for everyday listening.',
  notes: 'No prohibited claims found.',
};
const base = { model: 'gpt-5.6-sol', finishReason: 'stop', usage: { prompt_tokens: 120, completion_tokens: 80 } };

test('strict claims completion parser accepts pass, revise, and high severity block', () => {
  assert.deepEqual(parseClaimsCompletion({ ...base, text: JSON.stringify(cleanReview) }), cleanReview);

  const revise = {
    verdict: 'revise', risk: 28,
    violations: [{ phrase: 'guaranteed clearer hearing', rule: 'Unsupported outcome promise', severity: 'medium', fix: 'Remove the guarantee.' }],
    compliant_rewrite: 'A sound amplifier for everyday listening.', notes: 'Remove the unsupported guarantee.',
  };
  assert.deepEqual(parseClaimsCompletion({ ...base, text: JSON.stringify(revise) }), revise);

  const block = {
    verdict: 'block', risk: 92,
    violations: [{ phrase: 'cures hearing loss', rule: 'Medical treatment claim', severity: 'high', fix: 'Remove the treatment claim.' }],
    compliant_rewrite: 'A sound amplifier for everyday listening.', notes: 'Escalate the prohibited claim.',
  };
  assert.deepEqual(parseClaimsCompletion({ ...base, text: JSON.stringify(block) }), block);
});

test('syntactically valid JSON with finish_reason=length is rejected with safe completion diagnostics', () => {
  assert.throws(
    () => parseClaimsCompletion({ ...base, text: JSON.stringify(cleanReview), finishReason: 'length', usage: { prompt_tokens: 120, completion_tokens: 6000 } }),
    (error) => {
      assert.equal(error.code, 'incomplete_completion');
      assert.equal(error.diagnostics.finishReason, 'length');
      assert.equal(error.diagnostics.completionTokens, 6000);
      assert.doesNotMatch(error.message, /personal sound amplifier/);
      return true;
    },
  );
});

test('malformed JSON and refusals fail closed without retaining response text', () => {
  assert.throws(() => parseClaimsCompletion({ ...base, text: '{"verdict":"pass"' }), { code: 'malformed_json' });
  assert.throws(
    () => parseClaimsCompletion({ ...base, text: JSON.stringify(cleanReview), refusal: 'synthetic sensitive marker' }),
    (error) => {
      assert.equal(error.code, 'model_refusal');
      assert.equal(error.diagnostics.refusal, true);
      assert.doesNotMatch(error.message, /synthetic sensitive marker/);
      return true;
    },
  );
});

test('invalid risk/verdict, missing or extra fields, and inconsistent verdict/violation sets fail closed', () => {
  const cases = [
    [{ ...cleanReview, risk: 101 }, 'invalid_risk'],
    [{ ...cleanReview, verdict: 'unknown' }, 'invalid_verdict'],
    [{ ...cleanReview, compliant_rewrite: undefined }, 'invalid_schema'],
    [{ ...cleanReview, compliant_rewrite: '' }, 'invalid_rewrite'],
    [{ ...cleanReview, extra: 'unexpected' }, 'invalid_schema'],
    [{ ...cleanReview, violations: [{ phrase: 'unsafe', rule: 'r', severity: 'high', fix: 'f', extra: 'unexpected' }] }, 'invalid_violations'],
    [{ ...cleanReview, violations: [{ phrase: 'unsafe', rule: 'r', severity: 'high', fix: 'f' }] }, 'pass_with_violations'],
    [{ ...cleanReview, verdict: 'block', risk: 90 }, 'inconsistent_block_verdict'],
    [{ ...cleanReview, verdict: 'revise', risk: 20 }, 'inconsistent_revise_verdict'],
  ];
  for (const [review, code] of cases) {
    assert.throws(() => parseClaimsCompletion({ ...base, text: JSON.stringify(review) }), { code });
  }
});
