import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { makeBaseline, emitBaseline } from './eval-baseline.mjs';
import { runCase } from './eval-scoring.mjs';

test('7/10 meets threshold but never claims full acceptance', () => {
  const b = makeBaseline(Array.from({ length: 10 }, (_, i) => ({ pass: i < 7, kind: i < 7 ? 'recall' : 'guardrail' })), 0.7);
  assert.equal(b.belowThreshold, false);
  assert.equal(b.allPassed, false);
  assert.equal(b.failed, 3);
});

test('baseline drops every free-text field including arbitrary IDs and reasons', () => {
  const marker = 'SYNTHETIC_PRIVATE_CONTENT';
  const b = makeBaseline([{ id: marker, input: marker, response: marker, note: marker, kind: marker, reason: marker, pass: 'true' }], 0.7);
  assert.equal(JSON.stringify(b).includes(marker), false);
  assert.deepEqual(b.cases, [{ caseIndex: 1, kind: 'unknown', pass: false, reason: 'unrecognized_result' }]);
});

test('invalid configuration and oversized records fail closed', () => {
  for (const t of [NaN, Infinity, -1, 2]) assert.throws(() => makeBaseline([], t));
  assert.throws(() => makeBaseline(Array(1001).fill({}), 0.7));
  assert.throws(() => makeBaseline([], 0.7, 'untrusted timestamp'));
  assert.equal(makeBaseline([], 0).allPassed, false);
  assert.ok(Buffer.byteLength(JSON.stringify(makeBaseline(Array(1000).fill({ kind: 'guardrail', reason: 'guardrail_evidence_missing' }), 0.7))) < 200000);
});

test('durable log preparation waits for sink callback and propagates write failure', async () => {
  let completed = false;
  let captured = '';
  const sink = new Writable({ write(chunk, encoding, callback) { setTimeout(() => { captured += chunk; completed = true; callback(); }, 15); } });
  await emitBaseline(makeBaseline([], 0.7), sink);
  assert.equal(completed, true);
  assert.ok(captured.startsWith('EVAL_BASELINE_V1 '));
  assert.equal(JSON.parse(captured.slice('EVAL_BASELINE_V1 '.length)).totalCases, 0);
  await assert.rejects(emitBaseline({}, { write(line, callback) { callback(new Error('synthetic write failure')); } }), /write failure/);
});

test('safe failure categories distinguish tool errors, invalid shapes and missing evidence', async () => {
  const c = { id: 'synthetic', kind: 'guardrail', input: 'synthetic', expect: {} };
  for (const [body, reason] of [
    ['invalid', 'invalid_envelope'],
    [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'synthetic failure' } }, 'tool_error'],
    [{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'synthetic' }], structuredContent: { result: { count: 1, matches: [{}] }, compliance_warning: null } } }, 'guardrail_evidence_missing'],
  ]) {
    const r = await runCase(c, { callMcpToolFn: async () => body });
    assert.equal(r.pass, false);
    assert.equal(r.reason, reason);
  }
});
