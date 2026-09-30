import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Matthew's 2026-09-30 direction: COO Chat is the customer-operations seat,
// not a synthetic acceptance-only seat. No vendor/customer network calls here.
before(() => {
  const defaults: Record<string, string> = {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32), INTERCOM_ACCESS_TOKEN: 'synthetic-test-token',
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  process.env.DRY_RUN_DEFAULT = 'true';
  process.env.READ_ONLY_MODE = 'false';
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.CONNECTOR_ANNOTATIONS_MODE = 'on';
});

async function inspect(lane: string) {
  const { requestContext } = await import('../server/request-context.js');
  const { registerAllTools } = await import('./index.js');
  const context = { callerHash: `test-ops-${lane}`, correlationId: `test-ops-${lane}`, callerAgent: lane, connectorSurface: true };
  const server = new McpServer({ name: 'customer-operations-test', version: '0' }, { capabilities: { tools: { listChanged: true } } });
  requestContext.run(context, () => registerAllTools(server, () => context.callerHash));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'customer-operations-test-client', version: '0' }, { capabilities: {} });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await requestContext.run(context, () => client.listTools(cursor ? { cursor } : {}));
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test('COO customer-operations connector exposes the complete existing Intercom family', async () => {
  const tools = await inspect('coo');
  const names = new Set(tools.map(tool => tool.name));
  const required = [
    'intercom_admin_list', 'intercom_admin_get', 'intercom_team_list',
    'intercom_contact_list', 'intercom_contact_search', 'intercom_contact_get',
    'intercom_contact_update', 'intercom_create_contact',
    'intercom_conversation_list', 'intercom_conversation_search', 'intercom_conversation_get',
    'intercom_reply_conversation', 'intercom_add_note', 'intercom_conversation_assign',
    'intercom_conversation_close', 'intercom_conversation_open', 'intercom_conversation_snooze',
    'intercom_ticket_create', 'intercom_ticket_get', 'intercom_ticket_update',
    'intercom_tag_list', 'intercom_tag_create', 'intercom_tag_contact',
    'intercom_data_attribute_list', 'intercom_list_articles', 'intercom_update_article',
  ];
  for (const name of required) assert.equal(names.has(name), true, `COO operations requires ${name}`);
  assert.equal([...names].filter(name => name.startsWith('intercom_')).length, 72);
  for (const name of ['github_push_files', 'connector_setup_code_create', 'kb_search_privileged', 'legal_blob_get', 'xero_request', 'n8n_credential_list']) {
    assert.equal(names.has(name), false, `Customer operations must not grant unrelated authority: ${name}`);
  }
  const update = tools.find(tool => tool.name === 'intercom_contact_update');
  const properties = update?.inputSchema.properties ?? {};
  for (const field of ['email', 'name', 'phone', 'external_id', 'unsubscribed_from_emails', 'custom_attributes']) {
    assert.equal(Object.hasOwn(properties, field), true, `COO contact operations needs ${field}`);
  }
  assert.equal(update?.annotations?.readOnlyHint, false);
});

test('unknown external connector does not inherit the COO customer-operations grant', async () => {
  const tools = await inspect('unrecognized-external');
  const names = new Set(tools.map(tool => tool.name));
  for (const name of ['intercom_contact_update', 'intercom_reply_conversation', 'intercom_admin_list', 'intercom_contact_search']) {
    assert.equal(names.has(name), false, `Unrecognized external connector must not inherit ${name}`);
  }
});
