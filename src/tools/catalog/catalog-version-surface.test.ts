import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
});

test('catalog_version stays a canonical-definition fingerprint across internal and COO MCP projections', async () => {
  const { registerIntercomContactGet } = await import('../intercom/contact-get.js');
  const { registerCatalogListTools } = await import('./list-tools.js');
  const { requestContext } = await import('../../server/request-context.js');

  async function list(connectorSurface: boolean, suffix: string) {
    const context = {
      callerHash: `catalog-version-${suffix}`,
      correlationId: `catalog-version-${suffix}`,
      callerAgent: 'coo',
      connectorSurface,
      m365StaticAuth: false,
    };
    const server = new McpServer({ name: `catalog-version-${suffix}`, version: '0' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
    await requestContext.run(context, () => {
      registerIntercomContactGet(server, () => context.callerHash);
      registerCatalogListTools(server, () => context.callerHash);
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `catalog-version-client-${suffix}`, version: '0' }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const contact = tools.tools.find((tool) => tool.name === 'intercom_contact_get');
      assert.ok(contact, `${suffix} actual MCP tools/list contains intercom_contact_get`);
      const call = await requestContext.run(context, () => client.callTool({ name: 'catalog_list_tools', arguments: {} })) as {
        structuredContent?: { result?: { catalog_version?: string } };
      };
      const version = call.structuredContent?.result?.catalog_version;
      assert.ok(version, `${suffix} actual catalog_list_tools call returns catalog_version`);
      return { contact, version };
    } finally {
      await client.close();
      await server.close();
    }
  }

  const internalBefore = await list(false, 'internal-before');
  const connector = await list(true, 'connector');
  const internalAfter = await list(false, 'internal-after');

  const internalDescription = (internalBefore.contact.inputSchema as { properties: { contact_id: { description: string } } }).properties.contact_id.description;
  const connectorDescription = (connector.contact.inputSchema as { properties: { contact_id: { description: string } } }).properties.contact_id.description;
  assert.notEqual(connectorDescription, internalDescription, 'COO tools/list uses its declared lane-specific schema projection');
  assert.ok(internalBefore.contact.outputSchema, 'internal tools/list includes its output schema');
  assert.equal(connector.contact.outputSchema, undefined, 'connector tools/list omits output schema');
  assert.equal(internalBefore.version, connector.version, 'same canonical definitions retain one fingerprint across caller views');
  assert.equal(connector.version, internalAfter.version, 'returning to internal view retains that fingerprint');
});
