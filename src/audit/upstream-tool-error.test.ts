import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpstreamToolError } from './upstream-tool-error.js';

const sample = (code = 'intercom_request_error', status = 400) => ({
  name: 'IntercomFullError', code, status,
  message: 'Intercom returned an error.',
  nextStep: 'UNTRUSTED_RAW_NEXT_STEP',
  upstream: { errors: [{ message: 'SYNTHETIC_DO_NOT_DISCLOSE' }] },
});

test('preserves the Intercom request-error classification and HTTP status', () => {
  const result = parseUpstreamToolError(sample(), 'intercom_ticket_type_create');
  assert.ok(result, 'IntercomFullError must not collapse to generic tool_error');
  assert.equal(result.code, 'intercom_request_error');
  assert.equal(result.status, 400);
});
test('never copies Intercom upstream payloads or caller-provided next-step text', () => {
  const result = parseUpstreamToolError(sample(), 'intercom_ticket_type_create');
  assert.ok(result);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'nextStep', 'status']);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_DO_NOT_DISCLOSE|UNTRUSTED_RAW_NEXT_STEP|upstream/);
});
for (const [code, status] of [
  ['intercom_not_configured',0], ['intercom_invalid_path_segment',0],
  ['intercom_auth_failed',401], ['intercom_auth_failed',403],
  ['intercom_not_found',404], ['intercom_validation_error',422],
  ['intercom_rate_limited',429], ['intercom_upstream_error',503],
] as const) {
  test(`classifies ${code} at status ${status}`, () => {
    const result = parseUpstreamToolError(sample(code,status), 'intercom_ticket_type_get');
    assert.ok(result);
    assert.equal(result.code,code);
    assert.equal(result.status,status);
  });
}
test('does not recognize Intercom errors on another vendor tool', () => {
  assert.equal(parseUpstreamToolError(sample(), 'n8n_list_workflows'),null);
});
test('does not pass through arbitrary Intercom error codes', () => {
  assert.equal(parseUpstreamToolError(sample('SYNTHETIC_DO_NOT_DISCLOSE'), 'intercom_ticket_type_get'),null);
});
test('does not pass through malformed or non-HTTP status values', () => {
  for (const status of [-1,99,600,400.5,NaN]) {
    const result = parseUpstreamToolError(sample('intercom_request_error',status), 'intercom_ticket_type_get');
    assert.ok(result);
    assert.equal(result.status,undefined);
  }
});
test('retains Customer.io and n8n error behavior', () => {
  for (const name of ['CustomerIoApiError','N8nWebhookError']) {
    const result = parseUpstreamToolError({name,code:'test_code',nextStep:'Test next step',status:422},'existing_tool');
    assert.deepEqual(result,{code:'test_code',nextStep:'Test next step',status:422});
  }
});
test('retains exact pinned-observation diagnostic matching', () => {
  const value = {name:'PinnedObservationReaderError',code:'github_observation_receipt_unverified',nextStep:'Read the fixed receipt',status:404};
  assert.ok(parseUpstreamToolError(value,'github_graphrag_observation_receipt_get'));
  assert.equal(parseUpstreamToolError(value,'github_repo_get'),null);
});
test('rejects unknown errors and malformed values', () => {
  for (const value of [null,undefined,'error',{},new Error('Synthetic error')]) {
    assert.equal(parseUpstreamToolError(value,'intercom_ticket_type_get'),null);
  }
});
