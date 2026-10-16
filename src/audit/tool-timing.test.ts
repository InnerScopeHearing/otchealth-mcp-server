import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { logToolPhase, shouldSampleToolTiming, toolTimingLogFields } from './tool-timing.js';
import { logger } from './logger.js';
import { requestContext } from '../server/request-context.js';

test('success timing uses a stable 10 percent decision per parent request', () => {
  assert.equal(shouldSampleToolTiming('parent-00001', 'success'), shouldSampleToolTiming('parent-00001', 'success'));
  const selected = Array.from({ length: 1000 }, (_, i) => shouldSampleToolTiming(`parent-${i}`, 'success'));
  const count = selected.filter(Boolean).length;
  assert.ok(count >= 70 && count <= 130, `expected about 10%, got ${count}/1000`);
  assert.equal(shouldSampleToolTiming(undefined, 'success'), false);
  assert.equal(shouldSampleToolTiming(undefined, 'error'), true);
});

test('phase log fields allow only fixed dimensions and safe bounded values', () => {
  const fields = toolTimingLogFields({
    parentCorrelationId: 'parent-synthetic',
    toolCorrelationId: 'tool-synthetic',
    phase: 'operation',
    durationMs: 12.4,
    outcome: 'error',
    errorCode: 'aws_mcp_timeout',
  });
  assert.deepEqual(fields, {
    type: 'tool_phase_timing',
    mcp_request_correlation_id: 'parent-synthetic',
    correlation_id: 'tool-synthetic',
    phase: 'operation',
    duration_ms: 12,
    outcome: 'error',
    error_code: 'aws_mcp_timeout',
  });
  const hostile = toolTimingLogFields({
    parentCorrelationId: 'https://example.invalid/?token=SYNTHETIC_SECRET',
    toolCorrelationId: 'tool',
    phase: 'authorization?token=SYNTHETIC_SECRET',
    durationMs: -3,
    outcome: 'unknown',
    errorCode: 'private body SYNTHETIC_SECRET',
  });
  const serialized = JSON.stringify(hostile);
  for (const secret of ['SYNTHETIC_SECRET', 'example.invalid', 'private body']) assert.equal(serialized.includes(secret), false);
  assert.equal(hostile.phase, undefined);
  assert.equal(hostile.duration_ms, 0);
  assert.equal(hostile.error_code, undefined);
});

test('invalid phase outcomes and absent parent context cannot create success observations', () => {
  const fields = toolTimingLogFields({
    phase: 'write', durationMs: Number.NaN, outcome: 'unknown',
  });
  assert.equal(fields.mcp_request_correlation_id, undefined);
  assert.equal(fields.duration_ms, 0);
  assert.equal(fields.outcome, 'unknown');
});

test('timing error codes preserve known diagnostics and omit secret-shaped unknown values', () => {
  assert.equal(toolTimingLogFields({ phase: 'operation', durationMs: 1, outcome: 'error', errorCode: 'tool_error' }).error_code, 'tool_error');
  assert.equal(toolTimingLogFields({ phase: 'operation', durationMs: 1, outcome: 'error', errorCode: 'secret_token_value' }).error_code, undefined);
});

test('phase logs retain only the five fixed Xero HTTP categories', () => {
  for (const code of [
    'xero_http_unauthorized', 'xero_http_forbidden', 'xero_http_rate_limited',
    'xero_http_upstream_error', 'xero_http_request_error',
  ]) {
    assert.equal(toolTimingLogFields({ phase: 'operation', durationMs: 1, outcome: 'error', errorCode: code }).error_code, code);
  }
  for (const code of ['xero_http_SYNTHETIC_SECRET', 'xero_http_401_tenant_private', 'xero_http_timeout']) {
    assert.equal(toolTimingLogFields({ phase: 'operation', durationMs: 1, outcome: 'error', errorCode: code }).error_code, undefined);
  }
});

test('phase event links parent request and tool call IDs separately; missing parents stay unclaimed', async (t) => {
  const seen: Record<string, unknown>[] = [];
  const spy = mock.method(logger, 'info', (fields: Record<string, unknown>) => { seen.push(fields); });
  t.after(() => spy.mock.restore());
  const context = { callerHash: 'synthetic', correlationId: 'route-parent', callerAgent: '' };

  const logged = await requestContext.run({ ...context, parentCorrelationId: 'route-parent' }, () =>
    logToolPhase({ phase: 'operation', durationMs: 8, outcome: 'error', toolCorrelationId: 'tool-call' }));
  assert.equal(logged, true);
  assert.equal(seen[0].mcp_request_correlation_id, 'route-parent');
  assert.equal(seen[0].correlation_id, 'tool-call');

  const unlinked = await requestContext.run(context, () =>
    logToolPhase({ phase: 'operation', durationMs: 8, outcome: 'error' }));
  assert.equal(unlinked, true);
  assert.equal(seen[1].mcp_request_correlation_id, undefined);
  assert.equal(seen[1].correlation_id, undefined);
  assert.equal(await requestContext.run(context, () =>
    logToolPhase({ phase: 'operation', durationMs: 8, outcome: 'success' })), false);
  assert.equal(seen.length, 2);
});
