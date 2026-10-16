import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTool, callerSurfaceToolsFor } from './registry.js';
import { callerSurfaceFingerprint } from './catalog/caller-surface-fingerprint.js';
import { requestContext } from '../server/request-context.js';

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32), N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
});

const def = {
  name: 'github_workflow_run_failed_log_excerpt',
  category: 'read' as const,
  annotations: { title: 'Fixture', description: 'fixture description', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputShape: { run_id: z.string().describe('workflow run id') },
  outputShape: { result: z.string() },
  handler: async () => ({ data: { result: 'ok' } }),
};
const baselineDef = { ...def, name: 'catalog_probe' };

const wefunderDeniedBridgeNames = [
  'chat_action_submit',
  'chat_action_status',
  'chat_action_result',
] as const;
const wefunderPublicSurfaceNames = [
  ...wefunderDeniedBridgeNames,
  'catalog_probe',
  'browser_cloud_session_start',
  'browser_cloud_session_action',
  'browser_cloud_session_snapshot',
  'browser_cloud_session_stop',
] as const;

function registerSyntheticSurface(server: McpServer, lane: string): void {
  requestContext.run({ callerHash: `${lane}-test`, correlationId: lane, callerAgent: lane, connectorSurface: true }, () => {
    for (const name of wefunderPublicSurfaceNames) {
      registerTool(server, { ...def, name }, () => `${lane}-test`);
    }
  });
}

async function publicTools(server: McpServer): Promise<unknown[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'caller-surface-contract-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test('captured contract equals the public SDK tools/list after role filtering and schema projection', async () => {
  const makeServer = () => new McpServer({ name: 'surface-test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
  const cto = makeServer();
  const cro = makeServer();
  requestContext.run({ callerHash: 'cto-test', correlationId: 'cto', callerAgent: 'cto', connectorSurface: true }, () => {
    registerTool(cto, def, () => 'cto-test');
    registerTool(cto, baselineDef, () => 'cto-test');
  });
  requestContext.run({ callerHash: 'cro-test', correlationId: 'cro', callerAgent: 'cro', connectorSurface: true }, () => {
    registerTool(cro, baselineDef, () => 'cro-test');
    registerTool(cro, def, () => 'cro-test');
  });

  const ctoCaptured = callerSurfaceToolsFor(cto);
  const ctoPublic = await publicTools(cto);
  assert.deepEqual(ctoPublic, ctoCaptured);
  const fingerprint = callerSurfaceFingerprint(ctoCaptured);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);

  const croCaptured = callerSurfaceToolsFor(cro);
  const croPublic = await publicTools(cro);
  assert.deepEqual(croPublic, croCaptured);
  assert.deepEqual(croCaptured.map((tool) => tool.name), ['catalog_probe']);
  assert.ok(!croCaptured.some((tool) => tool.name === def.name), 'CTO-only tool must not appear on the CRO surface');
});

test('WeFunder public SDK tools/list hides only the denied chat-action bridge and preserves its company browser lane', async () => {
  const makeServer = () => new McpServer({ name: 'surface-test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
  const wefunder = makeServer();
  const cto = makeServer();
  registerSyntheticSurface(wefunder, 'wefunder-campaign-director');
  registerSyntheticSurface(cto, 'cto');

  const wefunderNames = (await publicTools(wefunder)).map((tool) => (tool as { name: string }).name);
  assert.deepEqual(wefunderNames, [
    'browser_cloud_session_action',
    'browser_cloud_session_snapshot',
    'browser_cloud_session_start',
    'browser_cloud_session_stop',
    'catalog_probe',
  ]);
  for (const denied of wefunderDeniedBridgeNames) {
    assert.equal(wefunderNames.includes(denied), false, `${denied} must not appear in WeFunder tools/list`);
  }

  const ctoNames = (await publicTools(cto)).map((tool) => (tool as { name: string }).name);
  for (const name of wefunderDeniedBridgeNames) {
    assert.ok(ctoNames.includes(name), `CTO's existing ${name} binding must remain advertised`);
  }
});
