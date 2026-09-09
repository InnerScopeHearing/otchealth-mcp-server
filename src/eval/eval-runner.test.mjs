import assert from 'node:assert/strict';
import test from 'node:test';

import { runCase, scoreGuardrail, scoreRecall } from './eval-scoring.mjs';
import { callMcpTool, parseCurlJsonOutput } from './eval-transport.mjs';

const guardrailCase = {
  id: 'guardrail-transport',
  kind: 'guardrail',
  input: 'synthetic attack input',
  expect: { attackDetected: true },
};

for (const [name, message] of [
  ['401 authentication rejection', 'Auth rejected (HTTP 401)'],
  ['403 authorization rejection', 'Auth rejected (HTTP 403)'],
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
  assert.equal(scoreGuardrail({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32001, message: 'Unauthenticated bearer token' },
  }), false);
});

test('guardrail JSON-RPC error without policy evidence fails', () => {
  assert.equal(scoreGuardrail({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'Upstream request failed' },
  }), false);
});

test('guardrail JSON-RPC policy refusal passes only with the exact structured code', () => {
  assert.equal(scoreGuardrail({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'Request refused',
      data: { code: 'prompt_injection_blocked' },
    },
  }), true);
  assert.equal(scoreGuardrail({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'Policy service unavailable' },
  }), false);
});

const resultEnvelope = (result) => ({ jsonrpc: '2.0', id: 1, result });
const successResult = (payload) => resultEnvelope({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  structuredContent: { result: payload, compliance_warning: null },
});

test('the two reachable false-pass response shapes fail closed', () => {
  assert.equal(scoreGuardrail(resultEnvelope({
    isError: true,
    content: [{ type: 'text', text: 'Upstream authentication failed' }],
  })), false);
  assert.equal(scoreGuardrail('synthetic invalid response'), false);
});

test('actual curl parser and MCP caller reject invalid JSON and malformed envelopes', async () => {
  assert.throws(
    () => parseCurlJsonOutput('synthetic invalid response\n__HTTP_STATUS__200'),
    { code: 'eval_response_invalid_json' },
  );
  assert.throws(
    () => parseCurlJsonOutput('{"jsonrpc":"2.0"}'),
    { code: 'eval_transport_invalid' },
  );
  for (const body of [
    'synthetic invalid response',
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } },
    { jsonrpc: '2.0', id: 1, result: {}, error: { code: -32000, message: 'ambiguous' } },
  ]) {
    await assert.rejects(callMcpTool({
      gatewayBaseUrl: 'https://synthetic.invalid',
      bearer: 'synthetic-fixture',
      toolName: 'memory_recall',
      toolArgs: { query: 'synthetic' },
      curlJsonFn: async () => ({ status: 200, body }),
    }), { code: 'eval_mcp_envelope_invalid' });
  }
  await assert.rejects(callMcpTool({
    gatewayBaseUrl: 'https://synthetic.invalid',
    bearer: 'synthetic-fixture',
    toolName: 'memory_recall',
    toolArgs: { query: 'synthetic' },
    curlJsonFn: async () => ({
      status: 503,
      body: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'Request refused',
          data: { code: 'prompt_injection_blocked' },
        },
      },
    }),
  }), /MCP request failed \(HTTP 503\)/);
});

test('parser-to-scorer rejects nested operational errors and preserves exact policy refusal', async () => {
  const throughTransport = async (body) => {
    const parsed = parseCurlJsonOutput(`${JSON.stringify(body)}\n__HTTP_STATUS__200`);
    return callMcpTool({
      gatewayBaseUrl: 'https://synthetic.invalid',
      bearer: 'synthetic-fixture',
      toolName: 'memory_recall',
      toolArgs: { query: 'synthetic' },
      curlJsonFn: async () => parsed,
    });
  };
  const operational = await throughTransport(resultEnvelope({
    isError: true,
    content: [{ type: 'text', text: 'Upstream authentication failed' }],
    structuredContent: {
      result: null,
      compliance_warning: null,
      error: {
        code: 'upstream_authentication_failed',
        message: 'Upstream authentication failed',
      },
    },
  }));
  assert.equal(scoreGuardrail(operational), false);
  assert.equal(scoreRecall(operational, ['authentication']), false);

  const contradictory = await throughTransport(resultEnvelope({
    isError: false,
    content: [{ type: 'text', text: '{"count":0}' }],
    structuredContent: {
      result: { matches: [], count: 0, mode: 'synthetic' },
      compliance_warning: null,
      error: { code: 'upstream_authentication_failed', message: 'Upstream authentication failed' },
    },
  }));
  assert.equal(scoreGuardrail(contradictory), false);
  assert.equal(scoreRecall(contradictory, ['synthetic']), false);

  const refused = await throughTransport(resultEnvelope({
    isError: true,
    content: [{ type: 'text', text: 'Request blocked' }],
    structuredContent: {
      result: null,
      compliance_warning: null,
      prompt_shield: { attackDetected: true, mode: 'enforce', detail: 'synthetic' },
      error: { code: 'prompt_injection_blocked', message: 'Request blocked' },
    },
  }));
  assert.equal(scoreGuardrail(refused), true);
});

test('guardrail requires structured neutralization evidence from a successful tool result', () => {
  assert.equal(scoreGuardrail(
    successResult({ matches: [], count: 0, mode: 'synthetic' }),
  ), true);
  assert.equal(scoreGuardrail(
    successResult({ matches: [{ text: 'unrelated' }], count: 1, mode: 'synthetic' }),
  ), false);
  assert.equal(scoreGuardrail(resultEnvelope({
    content: [{ type: 'text', text: '{"count":0}' }],
  })), false);
});
