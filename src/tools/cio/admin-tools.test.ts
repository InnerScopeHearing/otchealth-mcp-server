import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test-site';
process.env.CIO_TRACK_KEY ||= 'test-track';
process.env.CIO_APP_API_BEARER ||= 'test-app';
process.env.CIO_FLY_SERVICE_ACCOUNT_TOKEN ||= ['sa', 'live', 'test_service_account'].join('_');
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'y'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'z'.repeat(32);
process.env.READ_ONLY_MODE = 'false';
process.env.ENABLE_WRITE_TOOLS = 'true';
process.env.ENABLE_HIGH_RISK_TOOLS = 'true';
process.env.DRY_RUN_DEFAULT = 'true';
process.env.NODE_ENV = 'test';
process.env.SHIELD_MODE = 'off';
process.env.GROUNDEDNESS_MODE = 'off';

const { requestContext } = await import('../../server/request-context.js');
const { registerCioAdminTools } = await import('./admin-tools.js');
const { CIO_ADMIN_READ_TOOLS, CIO_ADMIN_WRITE_TOOLS } = await import('./admin-access.js');

interface CapturedTool {
  config: unknown;
  handler: (args: unknown) => Promise<Record<string, unknown>>;
}

function fakeServer(): { server: unknown; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool(name: string, config: unknown, handler: CapturedTool['handler']) {
      tools.set(name, { config, handler });
      return { remove: () => tools.delete(name) };
    },
  };
  return { server, tools };
}

async function invoke(tool: CapturedTool, callerAgent: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return requestContext.run(
    { callerHash: `hash-${callerAgent}`, correlationId: `corr-${callerAgent}`, callerAgent },
    () => tool.handler(args),
  );
}

function resultOf(response: Record<string, unknown>): Record<string, unknown> {
  const structured = response.structuredContent as Record<string, unknown> | undefined;
  assert.ok(structured);
  return structured.result as Record<string, unknown>;
}

test('registerCioAdminTools registers exactly the fixed 42-tool surface', () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  assert.equal(tools.size, 42);
  assert.deepEqual([...tools.keys()].sort(), [...CIO_ADMIN_READ_TOOLS, ...CIO_ADMIN_WRITE_TOOLS].sort());
});

test('frequency-cap dry-run is network-free, schema-shaped, and defaults to no execution', { concurrency: false }, async () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  let networkCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('network must not run in dry-run');
  }) as typeof fetch;
  try {
    const response = await invoke(tools.get('cio_admin_write_frequency_cap_create')!, 'cro', {
      name: 'Email cap',
      rules: [{ cap_limit: 2, channels: ['email'], retry_window_secs: 3600, window_secs: 86400 }],
      dry_run: true,
    });
    const result = resultOf(response);
    assert.equal(result.executed, false);
    assert.equal(result.dry_run, true);
    assert.deepEqual((result.request as Record<string, unknown>).body, {
      frequency_cap: {
        name: 'Email cap',
        rules: [{ cap_limit: 2, channels: ['email'], retry_window_secs: 3600, window_secs: 86400 }],
      },
    });
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('CRO may dry-run but cannot execute a live Customer.io admin write even with an approval reference', async () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  const response = await invoke(tools.get('cio_admin_write_message_limits_update')!, 'cro', {
    count: 3,
    retry_window_secs: 3600,
    window_secs: 86400,
    owner_approval_ref: 'owner-approval-123',
    dry_run: false,
  });
  const result = resultOf(response);
  assert.equal(result.executed, false);
  assert.equal(result.error, 'forbidden_cio_admin_lane');
  assert.match(String(result.reason), /cto\/exec/);
});

test('CTO live write without owner_approval_ref fails before any provider call', { concurrency: false }, async () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  let networkCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('network must not run without approval');
  }) as typeof fetch;
  try {
    const response = await invoke(tools.get('cio_admin_write_preserve_unsubscribes_on_merge')!, 'cto', {
      enabled: true,
      dry_run: false,
    });
    const result = resultOf(response);
    assert.equal(result.executed, false);
    assert.equal(result.error, 'owner_approval_required');
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('non-approved lane cannot read administrative Customer.io state and causes no provider call', { concurrency: false }, async () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  let networkCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('network must not run for forbidden lane');
  }) as typeof fetch;
  try {
    const response = await invoke(tools.get('cio_admin_read_workspace_health')!, 'coo', {});
    assert.equal(response.isError, true);
    assert.match(
      String((response.content as Array<{ text?: string }>)[0]?.text),
      /restricted to the cto\/cro\/exec agent\(s\)/,
    );
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('unexpected fields are rejected by the shared strict registry before a dry-run plan is built', async () => {
  const { server, tools } = fakeServer();
  registerCioAdminTools(server as never, () => 'caller-hash');
  const response = await invoke(tools.get('cio_admin_write_message_limits_update')!, 'cto', {
    count: 3,
    retry_window_secs: 3600,
    window_secs: 86400,
    unexpected: 'must fail',
    dry_run: true,
  });
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text?: string }>)[0]?.text), /Unrecognized key/);
});
