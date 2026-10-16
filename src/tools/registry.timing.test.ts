import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../audit/logger.js';
import { shouldSampleToolTiming } from '../audit/tool-timing.js';
import { requestContext } from '../server/request-context.js';
import { registerTool } from './registry.js';

type RegisteredHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const syntheticEnvironment: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-site', CIO_TRACK_KEY: 'synthetic-track-key', CIO_APP_API_BEARER: 'synthetic-bearer',
  PERPLEXITY_CONNECTOR_TOKEN: `synthetic-${'a'.repeat(40)}`, ADMIN_REVOKE_TOKEN: `synthetic-${'b'.repeat(40)}`,
  N8N_WEBHOOK_SECRET: `synthetic-${'c'.repeat(40)}`,
  SHIELD_MODE: 'off', GROUNDEDNESS_MODE: 'off', COLD_START_MODE: 'off',
  TOOL_CATALOG_CURATION_MODE: 'off', JIT_DOCTRINE_MODE: 'off', AUTO_JOURNAL_MODE: 'off', COMPLIANCE_MODE: 'enforce',
};
const previousEnvironment = Object.fromEntries(Object.keys(syntheticEnvironment).map((key) => [key, process.env[key]]));

before(() => Object.assign(process.env, syntheticEnvironment));
after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function captureHandler(handlerFn: (args: Record<string, unknown>) => Promise<{ data: unknown }>, name = 'synthetic_timing_tool'): RegisteredHandler {
  let handler: RegisteredHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: RegisteredHandler) {
      handler = candidate;
      return { remove() {} };
    },
  } as unknown as McpServer;
  registerTool(server, {
    name,
    category: 'read',
    annotations: { title: 'synthetic timing', description: 'synthetic', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: {},
    outputShape: { _jit_offloaded: z.boolean().optional(), result_id: z.string().optional() },
    handler: async (args) => handlerFn(args as Record<string, unknown>),
  }, () => 'synthetic-caller-hash');
  assert.ok(handler);
  return handler;
}

function captureTimingEvents(): { events: Record<string, unknown>[]; restore: () => void } {
  const events: Record<string, unknown>[] = [];
  const spy = mock.method(logger, 'info', (fields: Record<string, unknown>) => { events.push(fields); });
  return { events, restore: () => spy.mock.restore() };
}

test('actual registered callback logs bounded total outcome and parent/tool linkage', async () => {
  const parentId = Array.from({ length: 1000 }, (_, i) => `parent-${i}`).find((id) => shouldSampleToolTiming(id, 'success'))!;
  const handler = captureHandler(async () => ({ data: { count: 3 } }));
  const capture = captureTimingEvents();
  try {
    const response = await requestContext.run({
      callerHash: 'synthetic-caller-hash', correlationId: parentId, parentCorrelationId: parentId, callerAgent: 'cto',
    }, () => handler({}));
    assert.equal(response.isError, undefined);
    const event = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(event);
    assert.equal(event.outcome, 'success');
    assert.equal(event.mcp_request_correlation_id, parentId);
    assert.equal(typeof event.correlation_id, 'string');
    assert.equal(event.correlation_id === parentId, false);
    assert.equal(typeof event.duration_ms, 'number');
    assert.ok(capture.events.some((entry) => entry.type === 'result_projection' && entry.outcome === 'inline'));
  } finally {
    capture.restore();
  }
});

test('actual callback classifies input rejection and deferred output conservatively', async () => {
  const handler = captureHandler(async () => ({ data: { _jit_offloaded: true, result_id: 'synthetic-result' } }));
  const capture = captureTimingEvents();
  try {
    const context = { callerHash: 'synthetic-caller-hash', correlationId: 'parent-error', parentCorrelationId: 'parent-error', callerAgent: 'cto' };
    const invalid = await requestContext.run(context, () => handler({ unexpected: 'SYNTHETIC_SECRET' }));
    const rejectedEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.error_code === 'invalid_input');
    assert.ok(rejectedEvent);
    assert.equal(rejectedEvent.outcome, 'rejected');
    assert.equal(JSON.stringify(rejectedEvent).includes('SYNTHETIC_SECRET'), false);

    capture.events.length = 0;
    await requestContext.run(context, () => handler({}));
    const deferredEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(deferredEvent);
    assert.equal(deferredEvent.outcome, 'unknown');
    assert.equal(JSON.stringify(deferredEvent).includes('synthetic-result'), false);

    capture.events.length = 0;
    const actionFailure = captureHandler(async () => ({ data: { is_error: true } }));
    await requestContext.run(context, () => actionFailure({}));
    const actionEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(actionEvent);
    assert.equal(actionEvent.outcome, 'error');

    capture.events.length = 0;
    const timeout = captureHandler(async () => {
      throw Object.assign(new Error('synthetic timeout'), { code: 'aws_mcp_timeout' });
    });
    await requestContext.run(context, () => timeout({}));
    const timeoutEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(timeoutEvent);
    assert.equal(timeoutEvent.outcome, 'unknown');
    assert.equal(timeoutEvent.error_code, 'aws_mcp_timeout');

    capture.events.length = 0;
    const refusal = captureHandler(async () => {
      throw Object.assign(new Error('synthetic refusal'), { code: 'aws_mcp_forbidden' });
    });
    await requestContext.run(context, () => refusal({}));
    const refusalEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(refusalEvent);
    assert.equal(refusalEvent.outcome, 'rejected');
    assert.equal(refusalEvent.error_code, 'aws_mcp_forbidden');

    capture.events.length = 0;
    const withheld = captureHandler(async () => ({ data: { statement: 'Patent claim text stays withheld.' } }));
    const withheldResponse = await requestContext.run(context, () => withheld({}));
    assert.equal(withheldResponse.structuredContent?.result, null);
    assert.equal(withheldResponse.structuredContent?.compliance_warning?.requires_acknowledge, true);
    const withheldEvent = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
    assert.ok(withheldEvent);
    assert.equal(withheldEvent.outcome, 'rejected');
  } finally {
    capture.restore();
  }
});

test('actual Xero callback adds bounded HTTP timing categories without changing public errors', async () => {
  const { XeroHttpError } = await import('./xero/diagnostic-error.js');
  const context = { callerHash: 'synthetic-caller-hash', correlationId: 'parent-xero', parentCorrelationId: 'parent-xero', callerAgent: 'cto' };
  for (const [status, code] of [
    [401, 'xero_http_unauthorized'], [403, 'xero_http_forbidden'], [429, 'xero_http_rate_limited'],
    [503, 'xero_http_upstream_error'], [400, 'xero_http_request_error'],
  ] as const) {
    const legacyMessage = `synthetic HTTP ${status} SYNTHETIC_PRIVATE_BODY`;
    const handler = captureHandler(async () => { throw new XeroHttpError('accounting_get', status, legacyMessage); }, 'xero_synthetic_timing');
    const capture = captureTimingEvents();
    try {
      const response = await requestContext.run(context, () => handler({}));
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent?.error?.code, 'tool_error');
      assert.equal(response.structuredContent?.error?.message, legacyMessage);
      const event = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
      assert.ok(event);
      assert.equal(event.error_code, code);
      assert.equal(event.outcome, 'error');
      assert.equal(JSON.stringify(event).includes('SYNTHETIC_PRIVATE_BODY'), false);
    } finally { capture.restore(); }
  }
});

test('non-Xero and untyped errors keep generic callback diagnostics', async () => {
  const { XeroHttpError } = await import('./xero/diagnostic-error.js');
  const context = { callerHash: 'synthetic-caller-hash', correlationId: 'parent-xero-negative', parentCorrelationId: 'parent-xero-negative', callerAgent: 'cto' };
  for (const [name, error] of [
    ['synthetic_timing_tool', new XeroHttpError('accounting_get', 429, 'synthetic')],
    ['xero_synthetic_timing', Object.assign(new Error('HTTP 401 SYNTHETIC_PRIVATE_BODY'), { name: 'XeroHttpError', status: 401, stage: 'accounting_get' })],
  ] as const) {
    const handler = captureHandler(async () => { throw error; }, name);
    const capture = captureTimingEvents();
    try {
      await requestContext.run(context, () => handler({}));
      const event = capture.events.find((entry) => entry.type === 'tool_phase_timing' && entry.phase === 'operation');
      assert.ok(event);
      assert.equal(event.error_code, 'tool_error');
      assert.equal(JSON.stringify(event).includes('SYNTHETIC_PRIVATE_BODY'), false);
    } finally { capture.restore(); }
  }
});
