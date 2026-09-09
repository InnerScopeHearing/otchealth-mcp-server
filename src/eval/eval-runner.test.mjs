import assert from 'node:assert/strict';
import test from 'node:test';

import { runCase, scoreGuardrail } from './eval-scoring.mjs';

const guardrailCase = {
  id: 'guardrail-transport',
  kind: 'guardrail',
  input: 'synthetic attack input',
  expect: { attackDetected: true },
};

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
