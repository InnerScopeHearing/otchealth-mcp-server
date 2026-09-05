import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Regression for the 2026-09-05 Codex "512 tools, zero gateway tools" incident: Codex's MCP client
 * calls resources/list (and prompts/list) as an availability probe, and a tools-only server that
 * answered -32601 Method not found had ALL its tools hidden by Codex even though tools/list worked
 * and the connection was authenticated. The gateway now advertises empty resources/prompts
 * capabilities and answers both list calls with [], gated by MCP_STUB_RESOURCES_MODE (default on).
 *
 * ./mcp.js transitively loads config/env.ts (loadEnv() at import time), so the required env vars are
 * stubbed in before() and ./mcp.js is a DYNAMIC import inside each test -- the exact module-load
 * ordering the sibling registry.connector-annotations.test.ts documents.
 */

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

afterEach(() => {
  delete process.env.MCP_STUB_RESOURCES_MODE;
});

test('stubResourceListsEnabled: default on; only the literal "off" (any case/space) reverts it', async () => {
  const { stubResourceListsEnabled } = await import('./mcp.js');
  delete process.env.MCP_STUB_RESOURCES_MODE;
  assert.equal(stubResourceListsEnabled(), true);
  process.env.MCP_STUB_RESOURCES_MODE = '';
  assert.equal(stubResourceListsEnabled(), true);
  process.env.MCP_STUB_RESOURCES_MODE = 'garbage';
  assert.equal(stubResourceListsEnabled(), true);
  process.env.MCP_STUB_RESOURCES_MODE = 'on';
  assert.equal(stubResourceListsEnabled(), true);
  process.env.MCP_STUB_RESOURCES_MODE = 'off';
  assert.equal(stubResourceListsEnabled(), false);
  process.env.MCP_STUB_RESOURCES_MODE = '  OFF  ';
  assert.equal(stubResourceListsEnabled(), false);
});

test('serverOptions advertises empty resources+prompts when on, and omits them when off (exact prior tools-only shape)', async () => {
  const { serverOptions } = await import('./mcp.js');
  delete process.env.MCP_STUB_RESOURCES_MODE;
  const on = serverOptions().capabilities;
  assert.deepEqual(on.resources, {});
  assert.deepEqual(on.prompts, {});
  assert.ok((on.tools as { listChanged?: boolean }).listChanged, 'tools.listChanged must stay advertised');

  process.env.MCP_STUB_RESOURCES_MODE = 'off';
  const off = serverOptions().capabilities;
  assert.equal(off.resources, undefined, 'resources capability must be absent when off');
  assert.equal(off.prompts, undefined, 'prompts capability must be absent when off');
  assert.ok((off.tools as { listChanged?: boolean }).listChanged, 'tools.listChanged must stay advertised when off');
});

/** Boot a real McpServer with serverOptions()+applyStubResourceHandlers over an in-memory transport
 *  and drive it with a real Client, so this exercises the actual JSON-RPC path a connector uses. */
async function bootClient(): Promise<Client> {
  const { serverOptions, applyStubResourceHandlers } = await import('./mcp.js');
  const server = new McpServer({ name: 'stub-resources-test', version: '0' }, serverOptions());
  applyStubResourceHandlers(server);
  server.registerTool(
    'noop_tool',
    { description: 'a tool so tools/list is non-empty', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

test('a connected client sees resources+prompts in the server capabilities (the availability probe passes)', async () => {
  delete process.env.MCP_STUB_RESOURCES_MODE;
  const client = await bootClient();
  const caps = client.getServerCapabilities();
  assert.ok(caps?.resources, 'server must advertise the resources capability');
  assert.ok(caps?.prompts, 'server must advertise the prompts capability');
  assert.ok(caps?.tools, 'server must still advertise tools');
  await client.close();
});

test('resources/list, resources/templates/list and prompts/list return an empty array, NOT -32601', async () => {
  delete process.env.MCP_STUB_RESOURCES_MODE;
  const client = await bootClient();
  const res = await client.listResources();
  assert.deepEqual(res.resources, [], 'resources/list must be an empty array');
  const tmpl = await client.listResourceTemplates();
  assert.deepEqual(tmpl.resourceTemplates, [], 'resources/templates/list must be an empty array');
  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts, [], 'prompts/list must be an empty array');
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'noop_tool'), 'tools/list must still work');
  await client.close();
});
