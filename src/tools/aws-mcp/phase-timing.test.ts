import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awsMcpActionOutcome, awsMcpErrorOutcome } from './phase-timing.js';

test('AWS MCP nested action failure remains an operation error', () => {
  assert.equal(awsMcpActionOutcome(true), 'error');
  assert.equal(awsMcpActionOutcome(false), 'success');
});

test('timeout during operation has unknown effect while authorization and queue failures are rejected', () => {
  assert.equal(awsMcpErrorOutcome('aws_mcp_timeout', 'operation'), 'unknown');
  assert.equal(awsMcpErrorOutcome('aws_mcp_timeout', 'initialize'), 'error');
  assert.equal(awsMcpErrorOutcome('aws_mcp_rejected', 'operation'), 'rejected');
  assert.equal(awsMcpErrorOutcome('aws_mcp_busy', 'queue'), 'rejected');
  assert.equal(awsMcpErrorOutcome('aws_mcp_upstream_error', 'operation'), 'error');
});
