import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoSupersedeMode,
  cosineSimilarity,
  buildContradictionPrompt,
  parseContradictionVerdict,
  decideSupersession,
  bestCandidate,
  NEAR_DUPLICATE_THRESHOLD,
  MIN_CONFIDENCE,
  type SupersedeCandidate,
  type ContradictionVerdict,
} from './auto-supersede.js';

// ── mode / kill-switch ─────────────────────────────────────────────────────────────────────────
test("autoSupersedeMode: DEFAULT is 'suggest'; only 'off'/'auto' move off it; case-insensitive", () => {
  assert.equal(autoSupersedeMode(undefined), 'suggest');
  assert.equal(autoSupersedeMode(null), 'suggest');
  assert.equal(autoSupersedeMode(''), 'suggest');
  assert.equal(autoSupersedeMode('  '), 'suggest');
  assert.equal(autoSupersedeMode('garbage'), 'suggest', 'a typo must fall to the SAFE default, never silently to auto');
  assert.equal(autoSupersedeMode('off'), 'off');
  assert.equal(autoSupersedeMode('auto'), 'auto');
  assert.equal(autoSupersedeMode('AUTO'), 'auto');
  assert.equal(autoSupersedeMode(' Off '), 'off');
});

// ── cosine ───────────────────────────────────────────────────────────────────────────────────────
test('cosineSimilarity: identical=1, orthogonal=0, opposite=-1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) + 1) < 1e-9);
  assert.ok(cosineSimilarity([1, 2, 3], [2, 4, 6]) > 0.999, 'parallel vectors are ~1');
});

test('cosineSimilarity: every degenerate input returns 0, never NaN or throw', () => {
  assert.equal(cosineSimilarity(null, [1]), 0);
  assert.equal(cosineSimilarity([1], null), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0, 'length mismatch -> 0');
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero-norm -> 0, not NaN');
  assert.ok(!Number.isNaN(cosineSimilarity([0, 0], [0, 0])));
});

// ── prompt ─────────────────────────────────────────────────────────────────────────────────────
test('buildContradictionPrompt: carries both texts, biases to false-when-unsure, caps length', () => {
  const { system, user } = buildContradictionPrompt('X is now 44', 'X is 42');
  assert.match(system, /contradicts/);
  assert.match(system, /contradicts:false/, 'must instruct the model to default to no-contradiction when unsure');
  assert.match(user, /PRIOR:\nX is 42/);
  assert.match(user, /NEW:\nX is now 44/);
  const big = 'a'.repeat(9000);
  const { user: u2 } = buildContradictionPrompt(big, big);
  assert.ok(u2.length < 9000, 'each side is truncated so the classifier call stays cheap');
});

// ── verdict parsing (FAIL-SAFE) ──────────────────────────────────────────────────────────────────
test('parseContradictionVerdict: clean JSON, fenced JSON, and prose-wrapped JSON all parse', () => {
  assert.deepEqual(parseContradictionVerdict('{"contradicts":true,"confidence":0.9,"reason":"value changed"}'), {
    contradicts: true,
    confidence: 0.9,
    reason: 'value changed',
  });
  assert.equal(parseContradictionVerdict('```json\n{"contradicts":true,"confidence":0.8,"reason":"x"}\n```').contradicts, true);
  assert.equal(
    parseContradictionVerdict('Sure! Here is my answer: {"contradicts":false,"confidence":0.7,"reason":"added detail"} done').contradicts,
    false,
  );
});

test('parseContradictionVerdict: anything malformed FAILS SAFE to contradicts:false', () => {
  for (const bad of [null, undefined, '', 'not json', '{}', '{"confidence":0.9}', '{"contradicts":"yes"}', '{oops']) {
    const v = parseContradictionVerdict(bad as string);
    assert.equal(v.contradicts, false, `"${String(bad)}" must fail safe`);
  }
});

test('parseContradictionVerdict: out-of-range/absent confidence clamps to 0; long reason truncates', () => {
  assert.equal(parseContradictionVerdict('{"contradicts":true,"confidence":5}').confidence, 0);
  assert.equal(parseContradictionVerdict('{"contradicts":true,"confidence":-1}').confidence, 0);
  assert.equal(parseContradictionVerdict('{"contradicts":true}').confidence, 0);
  const long = parseContradictionVerdict(`{"contradicts":true,"confidence":0.9,"reason":"${'z'.repeat(300)}"}`);
  assert.ok(long.reason.length <= 140);
});

// ── candidate selection ──────────────────────────────────────────────────────────────────────────
test('bestCandidate: highest similarity, excludes self, tolerates empty/null', () => {
  const ns: SupersedeCandidate[] = [
    { id: 'a', kind: 'fact', similarity: 0.7 },
    { id: 'self', kind: 'fact', similarity: 0.99 },
    { id: 'b', kind: 'fact', similarity: 0.9 },
  ];
  assert.equal(bestCandidate('self', ns)?.id, 'b', 'self-match is excluded even though it is the most similar');
  assert.equal(bestCandidate('x', null), null);
  assert.equal(bestCandidate('x', []), null);
});

// ── the decision matrix (the load-bearing safety gates) ──────────────────────────────────────────
const YES: ContradictionVerdict = { contradicts: true, confidence: 0.9, reason: 'value changed' };
const cand = (over: Partial<SupersedeCandidate> = {}): SupersedeCandidate => ({ id: 'old', kind: 'fact', similarity: 0.95, ...over });

test("decideSupersession: mode=off is a hard no-op even on a slam-dunk contradiction", () => {
  const d = decideSupersession({ mode: 'off', newKind: 'fact', candidate: cand(), verdict: YES });
  assert.equal(d.action, 'none');
});

test('decideSupersession: no candidate -> none', () => {
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: null, verdict: YES }).action, 'none');
});

test('decideSupersession: non-supersedable kinds (status/episode/pitfall) never retire anything', () => {
  // new kind not supersedable
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'status', candidate: cand(), verdict: YES }).action, 'none');
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'pitfall', candidate: cand(), verdict: YES }).action, 'none');
  // prior kind not supersedable
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand({ kind: 'status' }), verdict: YES }).action, 'none');
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand({ kind: 'pitfall' }), verdict: YES }).action, 'none');
});

test('decideSupersession: below the similarity threshold -> none (different subject cannot contradict)', () => {
  const d = decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand({ similarity: NEAR_DUPLICATE_THRESHOLD - 0.01 }), verdict: YES });
  assert.equal(d.action, 'none');
});

test('decideSupersession: classifier says no-contradiction, or is not confident -> none', () => {
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand(), verdict: { contradicts: false, confidence: 0.9, reason: 'related' } }).action, 'none');
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand(), verdict: { contradicts: true, confidence: MIN_CONFIDENCE - 0.01, reason: 'maybe' } }).action, 'none');
});

test('THE FIX: mode=auto + confident same-subject contradiction -> auto-link the supersede', () => {
  const d = decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand({ id: '20260101-007' }), verdict: YES });
  assert.equal(d.action, 'auto-link');
  assert.equal(d.supersedeId, '20260101-007');
});

test('SAFE DEFAULT: the SAME slam-dunk contradiction only SUGGESTS in suggest mode (never mutates the graph)', () => {
  const d = decideSupersession({ mode: 'suggest', newKind: 'fact', candidate: cand({ id: '20260101-007' }), verdict: YES });
  assert.equal(d.action, 'suggest');
  assert.equal(d.supersedeId, '20260101-007', 'the candidate is surfaced for reconcile, but not linked');
});

test('decision is symmetric across fact/decision (both directions supersedable)', () => {
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'decision', candidate: cand({ kind: 'fact' }), verdict: YES }).action, 'auto-link');
  assert.equal(decideSupersession({ mode: 'auto', newKind: 'fact', candidate: cand({ kind: 'decision' }), verdict: YES }).action, 'auto-link');
});
