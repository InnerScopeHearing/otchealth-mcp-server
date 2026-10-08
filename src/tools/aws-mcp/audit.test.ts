/**
 * The audit line written for every AWS bridge call: one structured record with hashes and sizes only.
 * These tests pin its shape, the allowlist that keeps free text out of it, and the write-once behaviour.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The logger imports the gateway env loader, which validates a few required variables at import time.
Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track',
  CIO_APP_API_BEARER: 'synthetic-app',
  PERPLEXITY_CONNECTOR_TOKEN: 's'.repeat(32),
  ADMIN_REVOKE_TOKEN: 's'.repeat(32),
  N8N_WEBHOOK_SECRET: 's'.repeat(32),
  LOG_LEVEL: 'fatal',
});

const { logger } = await import('../../audit/logger.js');
const { AwsMcpRefusalError } = await import('./access.js');
const { AwsReaderUnavailableError } = await import('./credentials.js');
const { AwsMcpBridgeError } = await import('./upstream.js');
const {
  AWS_MCP_AUDIT_LOG_TYPE,
  BridgeCallAudit,
  UPSTREAM_TOOL_ERROR_CODE,
  bridgeCallLogFields,
  errorCodeOf,
  logBridgeCall,
  outcomeOfError,
  sha256Hex,
} = await import('./audit.js');
type Entry = import('./audit.js').BridgeCallAuditEntry;

const CALLER_HASH = 'ab12cd34'.repeat(8);
const SHA = 'f'.repeat(64);

const FULL: Entry = {
  bridgeTool: 'aws_mcp_tool_call',
  correlationId: 'b3f4b1c2-0d5e-4d3a-9a7f-1234567890ab',
  callerHash: CALLER_HASH,
  authKind: 'oauth',
  authGrant: 'authorization_code',
  upstreamTool: 'aws___run_script',
  region: 'us-east-1',
  scriptSha256: SHA,
  responseBytes: 1234,
  isError: false,
  outcome: 'ok',
  roleSessionName: 'gw-cto-b3f4b1c20d5e',
  latencyMs: 42,
};

interface Line {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}

function captureLogger(): { lines: Line[]; restore: () => void } {
  const lines: Line[] = [];
  const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) =>
    mock.method(logger, level, (fields: unknown, message: unknown) => {
      lines.push({ level, fields: fields as Record<string, unknown>, message: String(message ?? '') });
    }),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mock.restore()) };
}

test('sha256Hex is the SHA-256 of the UTF-8 text as lowercase hex', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(sha256Hex('caf' + String.fromCharCode(0xe9)), /^[0-9a-f]{64}$/);
});

test('a complete entry becomes exactly the documented fields', () => {
  assert.deepEqual(bridgeCallLogFields(FULL), {
    type: 'aws_mcp_bridge_call',
    bridge_tool: 'aws_mcp_tool_call',
    correlation_id: FULL.correlationId,
    caller_hash: CALLER_HASH,
    auth_kind: 'oauth',
    auth_grant: 'authorization_code',
    outcome: 'ok',
    is_error: false,
    upstream_tool: 'aws___run_script',
    region: 'us-east-1',
    script_sha256: SHA,
    response_bytes: 1234,
    role_session_name: 'gw-cto-b3f4b1c20d5e',
    latency_ms: 42,
  });
  assert.equal(AWS_MCP_AUDIT_LOG_TYPE, 'aws_mcp_bridge_call');
});

test('optional fields that were not known are absent, not empty', () => {
  const fields = bridgeCallLogFields({
    bridgeTool: 'aws_mcp_tool_list',
    correlationId: FULL.correlationId,
    callerHash: CALLER_HASH,
    authKind: 'm365',
    isError: true,
    outcome: 'refused',
    errorCode: 'aws_mcp_forbidden',
  });
  assert.deepEqual(fields, {
    type: 'aws_mcp_bridge_call',
    bridge_tool: 'aws_mcp_tool_list',
    correlation_id: FULL.correlationId,
    caller_hash: CALLER_HASH,
    auth_kind: 'm365',
    auth_grant: 'none',
    outcome: 'refused',
    is_error: true,
    error_code: 'aws_mcp_forbidden',
  });
});

test('every free-text field is validated against a strict pattern, so it can never carry text', () => {
  const hostile: Entry = {
    ...FULL,
    correlationId: 'corr\nforged-line',
    callerHash: 'caller hash with spaces',
    authKind: 'Bearer abc',
    authGrant: 'authorization_code; DROP TABLE tokens',
    upstreamTool: 'aws___run_script; rm -rf /',
    region: 'us east 1',
    scriptSha256: 'import boto3\nprint("the script itself")',
    errorCode: 'AccessDenied: SYNTHETIC-DETAIL',
    roleSessionName: 'name with spaces',
  };
  const fields = bridgeCallLogFields(hostile);
  assert.equal(fields.correlation_id, 'invalid');
  assert.equal(fields.caller_hash, 'unknown');
  assert.equal(fields.auth_kind, 'none');
  assert.equal(fields.auth_grant, 'none');
  for (const absent of ['upstream_tool', 'region', 'script_sha256', 'error_code', 'role_session_name']) {
    assert.equal(absent in fields, false, absent);
  }
  const everything = JSON.stringify(fields);
  for (const forbidden of ['forged-line', 'with spaces', 'Bearer', 'rm -rf', 'import boto3', 'SYNTHETIC-DETAIL', 'DROP TABLE']) {
    assert.equal(everything.includes(forbidden), false, forbidden);
  }
});

test('a missing auth kind or grant is recorded as none, and a missing correlation id or caller hash is replaced', () => {
  const fields = bridgeCallLogFields({ ...FULL, authKind: undefined, authGrant: undefined, correlationId: '', callerHash: '' });
  assert.equal(fields.auth_kind, 'none');
  assert.equal(fields.auth_grant, 'none');
  assert.equal(fields.correlation_id, 'invalid');
  assert.equal(fields.caller_hash, 'unknown');
});

test('sizes must be non-negative integers, and the script hash must be 64 lowercase hex characters', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '12' as unknown as number]) {
    const fields = bridgeCallLogFields({ ...FULL, responseBytes: bad, latencyMs: bad });
    assert.equal('response_bytes' in fields, false, String(bad));
    assert.equal('latency_ms' in fields, false, String(bad));
  }
  assert.equal(bridgeCallLogFields({ ...FULL, responseBytes: 0 }).response_bytes, 0);
  for (const bad of ['F'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), 'g'.repeat(64), ` ${'f'.repeat(63)}`]) {
    assert.equal('script_sha256' in bridgeCallLogFields({ ...FULL, scriptSha256: bad }), false, bad);
  }
});

test('fields that are not in the allowlist are never copied, even when a caller passes them', () => {
  const sneaky = {
    ...FULL,
    script: 'import boto3',
    token: 'synthetic-token',
    arguments: { script: 'x' },
    authorization: 'Bearer synthetic',
    signature: 'synthetic',
  } as unknown as Entry;
  const fields = bridgeCallLogFields(sneaky);
  assert.deepEqual(
    Object.keys(fields).sort(),
    ['auth_grant', 'auth_kind', 'bridge_tool', 'caller_hash', 'correlation_id', 'is_error', 'latency_ms', 'outcome', 'region', 'response_bytes', 'role_session_name', 'script_sha256', 'type', 'upstream_tool'],
  );
});

test('errorCodeOf reads the code of a typed bridge error and never derives it from message text', () => {
  assert.equal(errorCodeOf(new AwsMcpRefusalError('aws_mcp_forbidden', 'x')), 'aws_mcp_forbidden');
  assert.equal(errorCodeOf(new AwsMcpRefusalError('aws_mcp_grant_refused', 'x')), 'aws_mcp_grant_refused');
  assert.equal(errorCodeOf(new AwsMcpRefusalError('aws_mcp_disabled', 'x')), 'aws_mcp_disabled');
  assert.equal(errorCodeOf(new AwsMcpBridgeError('aws_mcp_timeout', 'x')), 'aws_mcp_timeout');
  assert.equal(errorCodeOf(new AwsReaderUnavailableError('assume_role_failed', 'AccessDenied')), 'aws_mcp_unavailable');
  assert.equal(errorCodeOf(new Error('aws_mcp_forbidden: spoofed by message text')), 'aws_mcp_internal_error');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'aws_mcp_forbidden' })), 'aws_mcp_internal_error');
  assert.equal(errorCodeOf('a string'), 'aws_mcp_internal_error');
  assert.equal(errorCodeOf(undefined), 'aws_mcp_internal_error');
  assert.equal(errorCodeOf(null), 'aws_mcp_internal_error');
});

test('outcomeOfError separates a policy refusal made before any AWS request from a failure', () => {
  assert.equal(outcomeOfError(new AwsMcpRefusalError('aws_mcp_forbidden', 'x')), 'refused');
  assert.equal(outcomeOfError(new AwsMcpBridgeError('aws_mcp_timeout', 'x')), 'error');
  assert.equal(outcomeOfError(new AwsReaderUnavailableError('assume_role_failed')), 'error');
  assert.equal(outcomeOfError(new Error('boom')), 'error');
});

test('logBridgeCall writes one info line for ok and upstream_error, and one warn line for refused and error', () => {
  const cap = captureLogger();
  try {
    for (const outcome of ['ok', 'upstream_error', 'refused', 'error'] as const) {
      logBridgeCall({ ...FULL, outcome });
    }
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines.map((l) => l.level), ['info', 'info', 'warn', 'warn']);
  assert.deepEqual(cap.lines.map((l) => l.message), [
    'aws_mcp_bridge_call aws_mcp_tool_call ok',
    'aws_mcp_bridge_call aws_mcp_tool_call upstream_error',
    'aws_mcp_bridge_call aws_mcp_tool_call refused',
    'aws_mcp_bridge_call aws_mcp_tool_call error',
  ]);
  for (const line of cap.lines) assert.equal(line.fields.type, 'aws_mcp_bridge_call');
});

test('logBridgeCall never throws, even when the logger does', () => {
  const sinks = (['info', 'warn'] as const).map((level) => mock.method(logger, level, () => { throw new Error('log sink is down'); }));
  try {
    assert.doesNotThrow(() => logBridgeCall({ ...FULL, outcome: 'ok' }));
    assert.doesNotThrow(() => logBridgeCall({ ...FULL, outcome: 'refused' }));
  } finally {
    sinks.forEach((sink) => sink.mock.restore());
  }
});

const BASE = { bridgeTool: 'aws_mcp_tool_call' as const, correlationId: FULL.correlationId, callerHash: CALLER_HASH, authKind: 'oauth', authGrant: 'authorization_code' };

test('BridgeCallAudit success writes one info line with what was noted, the size, and the role session', () => {
  const cap = captureLogger();
  try {
    const audit = new BridgeCallAudit(BASE);
    audit.note({ upstreamTool: 'aws___run_script', region: 'us-west-2' });
    audit.note({ scriptSha256: SHA });
    audit.note({}); // noting nothing changes nothing
    audit.success({ responseBytes: 77, isError: false, roleSessionName: 'gw-cto-abc' });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1);
  assert.equal(cap.lines[0].level, 'info');
  const { latency_ms: latency, ...rest } = cap.lines[0].fields;
  assert.ok(Number.isInteger(latency) && (latency as number) >= 0);
  assert.deepEqual(rest, {
    type: 'aws_mcp_bridge_call',
    bridge_tool: 'aws_mcp_tool_call',
    correlation_id: FULL.correlationId,
    caller_hash: CALLER_HASH,
    auth_kind: 'oauth',
    auth_grant: 'authorization_code',
    outcome: 'ok',
    is_error: false,
    upstream_tool: 'aws___run_script',
    region: 'us-west-2',
    script_sha256: SHA,
    response_bytes: 77,
    role_session_name: 'gw-cto-abc',
  });
});

test('BridgeCallAudit records an upstream tool error as upstream_error with a fixed code, at info level', () => {
  const cap = captureLogger();
  try {
    new BridgeCallAudit(BASE).success({ responseBytes: 9, isError: true });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1);
  assert.equal(cap.lines[0].level, 'info');
  assert.equal(cap.lines[0].fields.outcome, 'upstream_error');
  assert.equal(cap.lines[0].fields.is_error, true);
  assert.equal(cap.lines[0].fields.error_code, UPSTREAM_TOOL_ERROR_CODE);
  assert.equal(UPSTREAM_TOOL_ERROR_CODE, 'aws_mcp_upstream_tool_error');
});

test('BridgeCallAudit failure writes one warn line: refused for a policy refusal, error otherwise, with the typed code', () => {
  const cap = captureLogger();
  try {
    new BridgeCallAudit(BASE).failure(new AwsMcpRefusalError('aws_mcp_forbidden', 'x'));
    new BridgeCallAudit(BASE).failure(new AwsReaderUnavailableError('assume_role_failed', 'AccessDenied'));
    new BridgeCallAudit(BASE).failure(new Error('SYNTHETIC-MESSAGE-TEXT'));
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines.map((l) => l.level), ['warn', 'warn', 'warn']);
  assert.deepEqual(cap.lines.map((l) => [l.fields.outcome, l.fields.error_code, l.fields.is_error]), [
    ['refused', 'aws_mcp_forbidden', true],
    ['error', 'aws_mcp_unavailable', true],
    ['error', 'aws_mcp_internal_error', true],
  ]);
  assert.equal(JSON.stringify(cap.lines).includes('SYNTHETIC-MESSAGE-TEXT'), false, 'error message text is never logged');
});

test('BridgeCallAudit writes exactly one line however many times it is told the call ended', () => {
  const cap = captureLogger();
  try {
    const audit = new BridgeCallAudit(BASE);
    audit.failure(new AwsMcpRefusalError('aws_mcp_tool_blocked', 'x'));
    audit.success({ responseBytes: 1, isError: false });
    audit.failure(new Error('late'));
    audit.success({ responseBytes: 2, isError: true });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 1);
  assert.equal(cap.lines[0].fields.outcome, 'refused');
  assert.equal(cap.lines[0].fields.error_code, 'aws_mcp_tool_blocked');
});

test('every OAuth grant is recorded by name, and a refused machine token leaves a warn line naming its grant and the refusal code', () => {
  const cap = captureLogger();
  try {
    for (const authGrant of ['authorization_code', 'refresh_token', 'client_credentials']) {
      new BridgeCallAudit({ ...BASE, authGrant }).success({ responseBytes: 5, isError: false });
    }
    new BridgeCallAudit({ ...BASE, authGrant: 'client_credentials' }).failure(
      new AwsMcpRefusalError('aws_mcp_grant_refused', 'SYNTHETIC-MESSAGE-TEXT'),
    );
    new BridgeCallAudit({ ...BASE, authGrant: undefined }).failure(new AwsMcpRefusalError('aws_mcp_grant_refused', 'x'));
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines.map((l) => l.level), ['info', 'info', 'info', 'warn', 'warn']);
  assert.deepEqual(cap.lines.map((l) => l.fields.auth_grant), ['authorization_code', 'refresh_token', 'client_credentials', 'client_credentials', 'none']);
  assert.deepEqual(cap.lines.slice(3).map((l) => [l.fields.outcome, l.fields.error_code, l.fields.auth_kind]), [
    ['refused', 'aws_mcp_grant_refused', 'oauth'],
    ['refused', 'aws_mcp_grant_refused', 'oauth'],
  ]);
  assert.equal(JSON.stringify(cap.lines).includes('SYNTHETIC-MESSAGE-TEXT'), false);
});
