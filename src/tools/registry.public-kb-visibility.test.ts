import test, { before } from 'node:test';
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

test('connector-surface tools/list exposes public KB search only to authorized company seats', async () => {
  const { registerBrainPublicKbSearch } = await import('./kb/brain-public-kb-search.js');
  const { registerCatalogListTools } = await import('./catalog/list-tools.js');
  const { requestContext } = await import('../server/request-context.js');
  const companySeats = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer'];
  const withheldSeats = ['clo-personal', 'cpo', 'cco', 'exec', 'unknown'];

  for (const lane of [...companySeats, ...withheldSeats]) {
    const context = {
      callerHash: `synthetic-${lane}`,
      correlationId: `synthetic-public-kb-visibility-${lane}`,
      callerAgent: lane,
      connectorSurface: true,
      m365StaticAuth: false,
    };
    const server = new McpServer(
      { name: `test-${lane}-public-kb-visibility`, version: '0' },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
    await requestContext.run(context, () => {
      registerBrainPublicKbSearch(server, () => context.callerHash);
      // Keep tools/list available on seats where the public KB tool is correctly withheld.
      registerCatalogListTools(server, () => context.callerHash);
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${lane}-public-kb-client`, version: '0' }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      const publicKbSearch = tools.tools.find((tool) => tool.name === 'brain_public_kb_search');
      assert.equal(Boolean(publicKbSearch), companySeats.includes(lane), `${lane} connector tools/list visibility`);
      if (publicKbSearch) {
        assert.equal(publicKbSearch.annotations?.readOnlyHint, true);
        assert.equal(publicKbSearch.annotations?.destructiveHint, false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
