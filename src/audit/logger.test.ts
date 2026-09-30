import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallEndLogFields, toolCallStartLogFields } from './logger.js';

test('tool-call start logs retain correlation metadata and counts but never argument content', () => {
  const fields = toolCallStartLogFields({
    correlation_id: 'corr-synthetic-01',
    tool: 'synthetic_search',
    caller_hash: 'caller-hash-synthetic',
    input: {
      query: 'SYNTHETIC PROMPT AND DOCUMENT TEXT MUST NOT LEAK',
      nested: { authorization: 'SYNTHETIC_SECRET_VALUE', note: 'private nested text' },
    },
    dry_run: true,
    read_only_mode: true,
  });

  assert.deepEqual(fields, {
    type: 'tool_call_start',
    correlation_id: 'corr-synthetic-01',
    tool: 'synthetic_search',
    caller_hash: 'caller-hash-synthetic',
    input_field_count: 2,
    dry_run: true,
    read_only_mode: true,
  });
  const serialized = JSON.stringify(fields);
  for (const secret of ['SYNTHETIC PROMPT', 'SYNTHETIC_SECRET_VALUE', 'private nested text', 'authorization']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be logged`);
  }
});

test('tool-call end logs keep outcome, duration, safe counts and status, not audit values or error bodies', () => {
  const fields = toolCallEndLogFields({
    correlation_id: 'corr-synthetic-02',
    tool: 'synthetic_search',
    caller_hash: 'caller-hash-synthetic',
    outcome: 'success',
    latency_ms: 23,
    result_count: 0,
    before: { document: 'SYNTHETIC DOCUMENT TEXT' },
    after: { nested: { prompt: 'SYNTHETIC PROMPT' } },
    error_message: 'SYNTHETIC ERROR BODY',
  });

  assert.deepEqual(fields, {
    type: 'tool_call_end',
    correlation_id: 'corr-synthetic-02',
    tool: 'synthetic_search',
    caller_hash: 'caller-hash-synthetic',
    outcome: 'success',
    latency_ms: 23,
    result_count: 0,
  });
  const serialized = JSON.stringify(fields);
  for (const secret of ['SYNTHETIC DOCUMENT TEXT', 'SYNTHETIC PROMPT', 'SYNTHETIC ERROR BODY']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be logged`);
  }
});

test('tool-call end metadata distinguishes successful counts, zero results, upstream errors, and throttles', () => {
  const base = { correlation_id: 'corr', tool: 'search', caller_hash: 'caller', latency_ms: 7 };
  assert.deepEqual(toolCallEndLogFields({ ...base, outcome: 'success', result_count: 3 }), {
    type: 'tool_call_end', correlation_id: 'corr', tool: 'search', caller_hash: 'caller',
    outcome: 'success', latency_ms: 7, result_count: 3,
  });
  assert.equal(toolCallEndLogFields({ ...base, outcome: 'success', result_count: 0 }).result_count, 0);
  assert.deepEqual(toolCallEndLogFields({ ...base, outcome: 'error', error_code: 'upstream_error', status_code: 503 }), {
    type: 'tool_call_end', correlation_id: 'corr', tool: 'search', caller_hash: 'caller',
    outcome: 'error', latency_ms: 7, error_code: 'upstream_error', status_code: 503,
  });
  const failed = toolCallEndLogFields({
    ...base, outcome: 'error', error_code: 'upstream_error', status_code: 503,
    error_message: 'SYNTHETIC PROVIDER ERROR BODY MUST NOT LEAK',
  });
  assert.equal(JSON.stringify(failed).includes('SYNTHETIC PROVIDER ERROR BODY'), false);
  assert.deepEqual(toolCallEndLogFields({ ...base, outcome: 'rejected', error_code: 'rate_limited', status_code: 429 }), {
    type: 'tool_call_end', correlation_id: 'corr', tool: 'search', caller_hash: 'caller',
    outcome: 'rejected', latency_ms: 7, error_code: 'rate_limited', status_code: 429,
  });
});

