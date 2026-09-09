import assert from 'node:assert/strict';
import test from 'node:test';

import { runCase, scoreGuardrail, scoreRecall } from './eval-scoring.mjs';

for (const body of ['<html>upstream unavailable</html>', '', null, 42, [], {}, { result: {} }]) {
  test(`invalid HTTP 200 body cannot pass either scorer: ${JSON.stringify(body)}`, async () => {
    assert.equal(scoreGuardrail(body), false);
    assert.equal(scoreRecall(body, ['upstream']), false);
    const result = await runCase({ kind: 'guardrail', id: 'invalid', input: 'synthetic' }, {
      callMcpToolFn: async () => body,
    });
    assert.equal(result.pass, false);
  });
}

test('nested MCP tool error cannot pass through benign text or refusal terms', () => {
  for (const text of ['upstream unavailable', 'Blocked by policy', 'synthetic keyword']) {
    const body = { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text }] } };
    assert.equal(scoreGuardrail(body), false);
    assert.equal(scoreRecall(body, ['synthetic']), false);
  }
});

test('valid successful MCP result retains recall and guardrail behavior', () => {
  const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'synthetic match' }] } };
  assert.equal(scoreRecall(body, ['synthetic']), true);
  assert.equal(scoreGuardrail(body), true);
});

const guardrailCase = {
  id: 'guardrail-transport',
  kind: 'guardrail',
  input: 'synthetic attack input',
  expect: { attackDetected: true },
};

test('extracted scoring error notes redact a synthetic transport bearer', async () => {
  const fakeBearer = 'synthetic-test-only-marker';
  const result = await runCase(guardrailCase, {
    callMcpToolFn: async () => { throw new Error(`curl failed Authorization: Bearer ${fakeBearer}`); },
  });
  assert.equal(result.pass, false);
  assert.ok(!result.note.includes(fakeBearer));
  assert.match(result.note, /REDACTED/);
});

for (const [name, message] of [
  ['401 authentication rejection', 'Auth rejected (HTTP 401)'],
  ['403 authorization rejection', 'Auth rejected (HTTP 403)'],
  ['HTTP 500 response', 'MCP request failed (HTTP 500)'],
  ['timeout', 'curl: (28) Operation timed out'],
  ['network failure', 'curl: (6) Could not resolve host'],
]) {
  test(`guardrail transport case fails on ${name}`, async () => {
    const result = await runCase(guardrailCase, {
      callMcpToolFn: async () => {
        throw new Error(message);
      },
    });

    assert.equal(result.pass, false);
    assert.match(result.note, /^Error:/);
  });
}

test('guardrail JSON-RPC authentication error fails', () => {
  assert.equal(scoreGuardrail({ error: { code: -32001, message: 'Unauthenticated bearer token' } }), false);
});

test('guardrail JSON-RPC error without policy evidence fails', () => {
  assert.equal(scoreGuardrail({ error: { code: -32000, message: 'Upstream request failed' } }), false);
});

test('guardrail JSON-RPC transport error containing policy language fails', () => {
  assert.equal(scoreGuardrail({ error: { code: -32000, message: 'Policy service timed out' } }), false);
});

test('guardrail JSON-RPC authentication error containing policy language fails', () => {
  assert.equal(scoreGuardrail({ error: { code: -32001, message: 'Unauthenticated: policy blocked' } }), false);
});

test('guardrail JSON-RPC policy refusal passes', () => {
  assert.equal(scoreGuardrail({ error: { code: -32000, message: 'Blocked by prompt injection policy' } }), true);
});
