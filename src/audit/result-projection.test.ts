import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultProjectionLogFields } from './result-projection.js';

test('result projection fields are bounded to fixed outcomes, classes, and numeric counts', () => {
  const fields = resultProjectionLogFields({
    outcome: 'offloaded',
    originalBytes: 65537,
    initialReturnBytes: 5120,
  });
  assert.deepEqual(fields, {
    type: 'result_projection',
    outcome: 'offloaded',
    size_class: '64KiB-256KiB',
    original_bytes: 65537,
    initial_return_bytes: 5120,
  });
});

test('result projection fields never contain supplied content or arbitrary labels', () => {
  const fields = resultProjectionLogFields({
    outcome: 'fail_open',
    originalBytes: 40001,
    initialReturnBytes: 40001,
    returnedBytes: 0,
    page: 1,
    pages: 2,
    // Extra properties are deliberately ignored at runtime.
    payload: 'raw sensitive payload',
    error: 'exception detail',
    resultId: 'private-key-or-url',
  } as Parameters<typeof resultProjectionLogFields>[0]);
  assert.deepEqual(fields, {
    type: 'result_projection',
    outcome: 'fail_open',
    size_class: 'under-40KiB',
    original_bytes: 40001,
    initial_return_bytes: 40001,
    returned_bytes: 0,
    page: 1,
    pages: 2,
  });
  assert.equal(JSON.stringify(fields).includes('sensitive'), false);
  assert.equal(JSON.stringify(fields).includes('private-key'), false);
});

test('result projection clamps invalid counts and uses fixed classes at boundaries', () => {
  assert.equal(resultProjectionLogFields({ outcome: 'inline', originalBytes: 40000 }).size_class, 'under-40KiB');
  assert.equal(resultProjectionLogFields({ outcome: 'retrieved', originalBytes: 262145 }).size_class, '256KiB-1MiB');
  assert.equal(resultProjectionLogFields({ outcome: 'retrieved', originalBytes: 1600001 }).size_class, 'over-1.6MiB');
  const fields = resultProjectionLogFields({
    outcome: 'retrieved', originalBytes: -1, returnedBytes: 3.5, page: -1, pages: 1.5,
  });
  assert.deepEqual(fields, { type: 'result_projection', outcome: 'retrieved', size_class: 'unknown' });
});

test('result projection replaces an invalid runtime outcome with a fixed label', () => {
  const fields = resultProjectionLogFields({
    outcome: 'SYNTHETIC_PRIVATE_OUTCOME', originalBytes: 0,
  } as unknown as Parameters<typeof resultProjectionLogFields>[0]);
  assert.equal(fields.outcome, 'unknown');
  assert.equal(JSON.stringify(fields).includes('SYNTHETIC'), false);
});
