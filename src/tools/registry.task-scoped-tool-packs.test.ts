import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  connectorToolset,
  EXTERNAL_READONLY_TOOLSET,
  registerTool,
  type CallerHashProvider,
  type ToolDefinition,
} from './registry.js';
import {
  currentCallerAgent,
  currentTaskClass,
  requestContext,
} from '../server/request-context.js';
import {
  parseTaskClassHeader,
  selectTaskScopedToolPack,
  type TaskClass,
} from '../safety/task-tool-pack-selection.js';

const writeGateEnvNames = ['READ_ONLY_MODE', 'ENABLE_WRITE_TOOLS', 'ENABLE_HIGH_RISK_TOOLS'];
const previousWriteGateEnv = new Map<string, string | undefined>();

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
  for (const key of writeGateEnvNames) previousWriteGateEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of previousWriteGateEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function registeredToolNames(
  authenticatedSeat: string,
  taskClass: TaskClass,
  connectorSurface: boolean,
): Promise<string[]> {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash } = await import('../server/request-context.js');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const mcp = new McpServer(
    { name: 'task-pack-test', version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  await requestContext.run(
    {
      callerHash: 'test-hash',
      correlationId: 'test-corr',
      callerAgent: authenticatedSeat,
      connectorSurface,
      m365StaticAuth: false,
      taskClass,
    },
    () => registerAllTools(mcp, currentCallerHash),
  );
  return Object.keys((mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

test('authenticated tools/list is the read-only baseline when the header is missing or unknown', async () => {
  const seatAllowlist = new Set(EXTERNAL_READONLY_TOOLSET);
  for (const raw of [undefined, 'future-class']) {
    const taskClass = parseTaskClassHeader(raw);
    const actual = await registeredToolNames('cto', taskClass, true);
    const expected = selectTaskScopedToolPack({
      taskClass,
      authenticatedSeat: 'cto',
      authenticatedSeatAllowlist: seatAllowlist,
      readOnlyBaseline: EXTERNAL_READONLY_TOOLSET,
    });
    assert.deepEqual(actual.sort(), [...expected].sort());
    assert.ok(!actual.includes('github_create_branch'));
    assert.ok(!actual.includes('kb_search_privileged'));
  }
});

test('engineering tools/list intersects the CTO connector allowlist and excludes privileged or unrelated writes', async () => {
  const { loadEnv } = await import('../config/env.js');
  const seatAllowlist = connectorToolset(loadEnv(), 'cto');
  const actual = await registeredToolNames('cto', parseTaskClassHeader('engineering'), true);
  const expected = selectTaskScopedToolPack({
    taskClass: 'engineering',
    authenticatedSeat: 'cto',
    authenticatedSeatAllowlist: seatAllowlist,
    readOnlyBaseline: EXTERNAL_READONLY_TOOLSET,
  });
  assert.deepEqual(actual.sort(), [...expected].sort());
  assert.ok(actual.includes('github_create_branch'));
  assert.ok(actual.includes('github_push_files'));
  assert.ok(!actual.includes('github_merge_pull_request'));
  assert.ok(!actual.includes('github_dispatch_workflow'));
  assert.ok(!actual.includes('kb_search_privileged'));
  assert.ok(!actual.includes('legal_blob_get'));
  assert.ok(!actual.includes('memory_write'));
  assert.ok(actual.length <= 40, 'bounded pack should stay under 40 tools');
});

test('engineering tools/list for another connector remains within that authenticated seat allowlist', async () => {
  const { loadEnv } = await import('../config/env.js');
  const seatAllowlist = connectorToolset(loadEnv(), 'coo');
  const actual = await registeredToolNames('coo', parseTaskClassHeader('engineering'), true);
  const expected = selectTaskScopedToolPack({
    taskClass: 'engineering',
    authenticatedSeat: 'coo',
    authenticatedSeatAllowlist: seatAllowlist,
    readOnlyBaseline: EXTERNAL_READONLY_TOOLSET,
  });
  assert.deepEqual(actual.sort(), [...expected].sort());
  assert.ok(!actual.includes('github_create_branch'));
  assert.ok(!actual.includes('intercom_contact_search'));
});

test('tools/call outside the selected read-only pack is rejected as unregistered', async () => {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash } = await import('../server/request-context.js');
  const mcp = new McpServer(
    { name: 'task-pack-rejection-test', version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  await requestContext.run(
    {
      callerHash: 'test-hash',
      correlationId: 'test-corr',
      callerAgent: 'cto',
      connectorSurface: false,
      m365StaticAuth: false,
      taskClass: 'read_only',
    },
    () => registerAllTools(mcp, currentCallerHash),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: 'task-pack-test-client', version: '0' }, { capabilities: {} });
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    assert.ok(!listed.tools.some((tool) => tool.name === 'github_create_branch'));
    const response = await client.callTool({ name: 'github_create_branch', arguments: {} });
    assert.equal(response.isError, true);
  } finally {
    await client.close();
    await mcp.close();
  }
});

test('engineering visibility preserves authenticated identity, write schema confirmations, and write gates', async () => {
  process.env.READ_ONLY_MODE = 'true';
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.ENABLE_HIGH_RISK_TOOLS = 'true';
  const registered = new Map<string, {
    config: Record<string, unknown>;
    handler: (args: unknown) => Promise<{
      structuredContent?: { error?: { code?: string } };
      isError?: boolean;
    }>;
  }>();
  const server = {
    registerTool(
      name: string,
      config: Record<string, unknown>,
      handler: (args: unknown) => Promise<{
        structuredContent?: { error?: { code?: string } };
        isError?: boolean;
      }>,
    ) {
      registered.set(name, { config, handler });
      return { remove: () => registered.delete(name) };
    },
  } as unknown as McpServer;
  let handlerCalls = 0;
  const writeDefinition: ToolDefinition<Record<string, never>, Record<string, never>> = {
    name: 'github_create_branch',
    category: 'write_simple',
    annotations: {
      title: 'Create branch',
      description: 'Creates a branch.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {},
    handler: async () => {
      handlerCalls += 1;
      return { data: { created: true } };
    },
  };
  const hashProvider: CallerHashProvider = () => 'test-hash';
  await requestContext.run(
    {
      callerHash: 'test-hash',
      correlationId: 'test-corr',
      callerAgent: 'cto',
      connectorSurface: false,
      m365StaticAuth: false,
      taskClass: parseTaskClassHeader('engineering'),
    },
    async () => {
      assert.equal(currentCallerAgent(), 'cto');
      assert.equal(currentTaskClass(), 'engineering');
      registerTool(server, writeDefinition, hashProvider);
    },
  );

  const writeTool = registered.get('github_create_branch');
  assert.ok(writeTool, 'engineering pack should advertise the bounded branch-write tool to CTO');
  const inputSchema = writeTool.config.inputSchema as Record<string, unknown>;
  assert.ok('dry_run' in inputSchema, 'per-write dry_run confirmation must remain available');
  assert.ok('acknowledge_warning' in inputSchema, 'per-write warning acknowledgement must remain available');

  const result = await requestContext.run(
    {
      callerHash: 'test-hash',
      correlationId: 'test-corr',
      callerAgent: 'cto',
      connectorSurface: false,
      m365StaticAuth: false,
      taskClass: 'engineering',
    },
    () => writeTool.handler({ dry_run: false, acknowledge_warning: true }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, 'write_disabled');
  assert.equal(handlerCalls, 0, 'class selection must not bypass the existing write gate');
});
