import test from 'node:test';
import assert from 'node:assert/strict';
import { probeIntercomOperations, INTERCOM_READINESS_OPERATIONS } from './operations-readiness.js';
import { IntercomOperationError } from './operations-client.js';

test('readiness uses only fixed metadata requests and omits account/provider content', async () => {
  const called: string[] = [];
  const result = await probeIntercomOperations({ configured: true, execute: async (input) => {
    called.push(input.operation_id);
    return { status: 200, data: { app: { id: 'workspace-test', name: 'private-name' }, token: 'private-token', body: 'private-body' } };
  } });
  assert.deepEqual(called, [...INTERCOM_READINESS_OPERATIONS]);
  assert.equal(result.ready, true);
  assert.equal(result.workspace_id, 'workspace-test');
  assert.doesNotMatch(JSON.stringify(result), /private-name|private-token|private-body/);
});

test('provider rejection is a blocked receipt; it is never an empty success', async () => {
  const result = await probeIntercomOperations({ configured: true, execute: async () => { throw new IntercomOperationError('provider_rejected_request', 403, 'not emitted'); } });
  assert.equal(result.ready, false);
  assert.equal(result.checks.length, 7);
  assert.ok(result.checks.every((check) => check.http_status === 403 && check.state === 'blocked'));
  let called = false;
  const absent = await probeIntercomOperations({ configured: false, execute: async () => { called = true; return { status: 200, data: {} }; } });
  assert.equal(absent.ready, false);
  assert.equal(called, false);
});
