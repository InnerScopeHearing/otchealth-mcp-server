import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const COO_INTERCOM_TOOL_NAMES = [
  'intercom_admin_set_away',
  'intercom_team_get',
  'intercom_team_list',
  'intercom_ticket_type_get',
  'intercom_ticket_type_list',
  'intercom_ticket_type_create',
  'intercom_ticket_type_update',
  'intercom_tag_create',
  'intercom_tag_update',
  'intercom_data_attribute_create',
  'intercom_data_attribute_update',
  'intercom_contact_get',
  'intercom_contact_update',
] as const;

const COO_INTERCOM_WRITE_TOOL_NAMES = [
  'intercom_admin_set_away',
  'intercom_ticket_type_create',
  'intercom_ticket_type_update',
  'intercom_tag_create',
  'intercom_tag_update',
  'intercom_data_attribute_create',
  'intercom_data_attribute_update',
  'intercom_contact_update',
] as const;

const COO_INTERCOM_DENIED_TOOL_NAMES = [
  'intercom_contact_list',
  'intercom_contact_search',
  'intercom_contact_list_companies',
  'intercom_contact_list_tags',
  'intercom_contact_archive',
  'intercom_contact_unarchive',
  'intercom_conversation_search',
  'intercom_conversation_get',
  'intercom_ticket_search',
  'intercom_ticket_get',
  'intercom_event_list',
  'intercom_note_list',
  'intercom_company_list_contacts',
  'intercom_list_articles',
  'intercom_reply_conversation',
  'intercom_article_delete',
  'intercom_collection_delete',
  'intercom_contact_delete',
  'intercom_company_delete',
] as const;

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
    INTERCOM_ACCESS_TOKEN: 'synthetic-intercom-token',
  };
  for (const [key, value] of Object.entries(required)) process.env[key] ??= value;
  process.env.DRY_RUN_DEFAULT = 'true';
  process.env.READ_ONLY_MODE = 'false';
  process.env.ENABLE_WRITE_TOOLS = 'true';
  process.env.CONNECTOR_ANNOTATIONS_MODE = 'on';
});

interface ConnectorHarness {
  listTools(): Promise<ToolSummary[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
}

interface ToolSummary {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

async function bootConnector(lane: string, connectorSurface = true, intercomOnly = false): Promise<ConnectorHarness> {
  const { requestContext } = await import('../server/request-context.js');
  const context = {
    callerHash: `test-${lane}`,
    correlationId: `test-${lane}-correlation`,
    callerAgent: lane,
    connectorSurface,
  };
  const server = new McpServer(
    { name: `test-${lane}-connector`, version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );

  await requestContext.run(context, async () => {
    const callerHash = () => context.callerHash;
    if (intercomOnly) {
      const { registerIntercomAdminSetAway } = await import('./intercom/admin-set-away.js');
      const { registerIntercomTicketTypeCreate } = await import('./intercom/ticket-type-create.js');
      const { registerIntercomTicketTypeUpdate } = await import('./intercom/ticket-type-update.js');
      const { registerIntercomTagCreate } = await import('./intercom/tag-create.js');
      const { registerIntercomTagUpdate } = await import('./intercom/tag-update.js');
      const { registerIntercomDataAttributeCreate } = await import('./intercom/data-attribute-create.js');
      const { registerIntercomDataAttributeUpdate } = await import('./intercom/data-attribute-update.js');
      const { registerIntercomContactGet } = await import('./intercom/contact-get.js');
      const { registerIntercomContactUpdate } = await import('./intercom/contact-update.js');
      registerIntercomAdminSetAway(server, callerHash);
      registerIntercomTicketTypeCreate(server, callerHash);
      registerIntercomTicketTypeUpdate(server, callerHash);
      registerIntercomTagCreate(server, callerHash);
      registerIntercomTagUpdate(server, callerHash);
      registerIntercomDataAttributeCreate(server, callerHash);
      registerIntercomDataAttributeUpdate(server, callerHash);
      registerIntercomContactGet(server, callerHash);
      registerIntercomContactUpdate(server, callerHash);
    } else {
      const { registerAllTools } = await import('./index.js');
      registerAllTools(server, callerHash);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `test-${lane}-client`, version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async listTools() {
      const tools: ToolSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await requestContext.run(context, () => client.listTools(cursor ? { cursor } : {}));
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool(name, args) {
      return requestContext.run(context, () => client.callTool({ name, arguments: args })) as ReturnType<ConnectorHarness['callTool']>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test('COO connector exposes only the explicit Intercom operations, and blocks customer-content and irreversible calls', async () => {
  const connector = await bootConnector('coo');
  try {
    const tools = await connector.listTools();
    const intercomNames = tools.map((tool) => tool.name).filter((name) => name.startsWith('intercom_')).sort();
    assert.deepEqual(intercomNames, [...COO_INTERCOM_TOOL_NAMES].sort());

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of COO_INTERCOM_DENIED_TOOL_NAMES) {
      assert.equal(byName.has(name), false, `COO Chat must not advertise ${name}`);
    }

    for (const name of COO_INTERCOM_DENIED_TOOL_NAMES) {
      const blocked = await connector.callTool(name, {}).catch((error: unknown) => error);
      if (blocked instanceof Error) {
        assert.match(blocked.message, /not found|unknown tool/i, `${name} must be rejected at tools/call`);
      } else {
        assert.equal(blocked.isError, true, `${name} must be rejected at tools/call`);
        assert.match((blocked.content ?? []).map((item) => item.text ?? '').join('\n'), /not found|unknown tool/i);
      }
    }
  } finally {
    await connector.close();
  }
});

test('COO Intercom writes retain the MCP write-approval annotation and default to a non-executing dry run', async () => {
  const connector = await bootConnector('coo');
  try {
    const tools = await connector.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of COO_INTERCOM_WRITE_TOOL_NAMES) {
      const annotations = byName.get(name)?.annotations;
      assert.equal(annotations?.readOnlyHint, false, `${name} must be annotated as a write`);
      assert.equal(annotations?.destructiveHint, false, `${name} remains a bounded configuration write`);
      assert.equal(annotations?.openWorldHint, true, `${name} targets the Intercom service`);
    }

    const result = await connector.callTool('intercom_admin_set_away', {
      admin_id: 'synthetic-admin-id',
      away_mode_enabled: true,
      away_mode_reassign: false,
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const structured = result.structuredContent as {
      dry_run?: boolean;
      result?: { executed?: boolean; dry_run?: boolean };
    } | undefined;
    assert.equal(structured?.dry_run, true);
    assert.equal(structured?.result?.dry_run, true);
    assert.equal(structured?.result?.executed, false);
  } finally {
    await connector.close();
  }
});

test('COO connector omits auto-reassignment and ticket-type description while internal schema remains full', async () => {
  const originalFetch = globalThis.fetch;
  const writes: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    writes.push({ path: url.pathname, body });
    return new Response('{}', { status: 200 });
  };

  const connector = await bootConnector('coo', true, true);
  try {
    const tools = new Map((await connector.listTools()).map((tool) => [tool.name, tool]));
    const awayProperties = tools.get('intercom_admin_set_away')?.inputSchema?.properties ?? {};
    const ticketTypeProperties = tools.get('intercom_ticket_type_update')?.inputSchema?.properties ?? {};
    assert.equal(Object.hasOwn(awayProperties, 'away_mode_reassign'), false);
    assert.equal(Object.hasOwn(ticketTypeProperties, 'description'), false);

    const awayWithAutoReassign = await connector.callTool('intercom_admin_set_away', {
      admin_id: 'synthetic-admin-id',
      away_mode_enabled: true,
      away_mode_reassign: true,
      dry_run: false,
    });
    assert.equal(awayWithAutoReassign.isError, undefined);
    assert.equal((awayWithAutoReassign.structuredContent as { dry_run?: boolean } | undefined)?.dry_run, false);

    const updateWithDescription = await connector.callTool('intercom_ticket_type_update', {
      ticket_type_id: 'synthetic-ticket-type-id',
      description: 'synthetic sensitive text',
      dry_run: false,
    });
    assert.equal(updateWithDescription.isError, undefined);
    assert.equal((updateWithDescription.structuredContent as { dry_run?: boolean } | undefined)?.dry_run, false);
    assert.deepEqual(writes, [
      {
        path: '/admins/synthetic-admin-id/away',
        body: { away_mode_enabled: true, away_mode_reassign: false },
      },
      { path: '/ticket_types/synthetic-ticket-type-id', body: {} },
    ]);
    assert.equal(JSON.stringify(writes).includes('synthetic sensitive text'), false);
  } finally {
    await connector.close();
    globalThis.fetch = originalFetch;
  }

  const internal = await bootConnector('coo', false, true);
  try {
    const tools = new Map((await internal.listTools()).map((tool) => [tool.name, tool]));
    assert.equal(Object.hasOwn(tools.get('intercom_admin_set_away')?.inputSchema?.properties ?? {}, 'away_mode_reassign'), true);
    assert.equal(Object.hasOwn(tools.get('intercom_ticket_type_update')?.inputSchema?.properties ?? {}, 'description'), true);
  } finally {
    await internal.close();
  }
});

test('COO may manage Intercom ticket types, tags, and data-attribute definitions without customer records', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    return new Response(JSON.stringify({
      id: url.pathname === '/data_attributes' ? 792 : 'synthetic-config-id',
      name: record.name ?? 'Synthetic Intercom Config',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let connector: ConnectorHarness | undefined;
  try {
    connector = await bootConnector('coo', true, true);
    const createTicketType = {
      name: 'Synthetic COO Ticket Type',
      description: 'Synthetic integration test metadata',
      icon: '🎟',
      is_internal: true,
    };
    const createTag = { name: 'synthetic-coo-ops-test' };
    const updateTag = { tag_id: 'synthetic-tag-id', name: 'synthetic-coo-ops-renamed' };
    const createAttribute = {
      name: 'synthetic_coo_test_attribute',
      model: 'contact',
      data_type: 'string',
      description: 'Synthetic integration test metadata',
      options: [{ value: 'synthetic-value' }],
    };
    const updateAttribute = {
      attribute_id: 792,
      description: 'Synthetic integration test metadata updated',
      options: [{ value: 'synthetic-updated-value' }],
      archived: false,
    };
    const operations: Array<[string, Record<string, unknown>]> = [
      ['intercom_ticket_type_create', createTicketType],
      ['intercom_tag_create', createTag],
      ['intercom_tag_update', updateTag],
      ['intercom_data_attribute_create', createAttribute],
      ['intercom_data_attribute_update', updateAttribute],
    ];

    for (const [name, args] of operations) {
      const result = await connector.callTool(name, args);
      assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
      const structured = result.structuredContent as {
        dry_run?: boolean;
        result?: { executed?: boolean; dry_run?: boolean };
      } | undefined;
      assert.equal(structured?.dry_run, true, `${name} must default to dry_run`);
      assert.equal(structured?.result?.dry_run, true, `${name} must report the preview`);
      assert.equal(structured?.result?.executed, false, `${name} preview must not execute`);
    }
    assert.deepEqual(requests, [], 'default dry runs must not reach Intercom');

    for (const [name, args] of operations) {
      const result = await connector.callTool(name, { ...args, dry_run: false });
      assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
      const structured = result.structuredContent as {
        dry_run?: boolean;
        result?: { executed?: boolean; dry_run?: boolean };
      } | undefined;
      assert.equal(structured?.dry_run, false, `${name} must execute only when explicitly requested`);
      assert.equal(structured?.result?.dry_run, false);
      assert.equal(structured?.result?.executed, true);
    }

    assert.deepEqual(requests, [
      {
        method: 'POST',
        path: '/ticket_types',
        body: createTicketType,
      },
      {
        method: 'POST',
        path: '/tags',
        body: createTag,
      },
      {
        method: 'POST',
        path: '/tags',
        body: { id: updateTag.tag_id, name: updateTag.name },
      },
      {
        method: 'POST',
        path: '/data_attributes',
        body: createAttribute,
      },
      {
        method: 'PUT',
        path: '/data_attributes/792',
        body: {
          description: updateAttribute.description,
          options: updateAttribute.options,
          archived: false,
        },
      },
    ]);
  } finally {
    if (connector) await connector.close();
    globalThis.fetch = originalFetch;
  }
});

test('COO synthetic contact tools expose only the fixed test scope and redact contact fields', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body });
    return new Response(JSON.stringify({
      id: '6ab5f0e0843a84e15468a558',
      name: 'Synthetic Intercom Contact Verification',
      email: 'hidden@example.invalid',
      phone: '+10000000000',
      custom_attributes: { internal_note: 'hidden' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let connector: ConnectorHarness | undefined;
  try {
    connector = await bootConnector('coo', true, true);
    const tools = new Map((await connector.listTools()).map((tool) => [tool.name, tool]));
    const contactGetProperties = tools.get('intercom_contact_get')?.inputSchema?.properties ?? {};
    const contactUpdateProperties = tools.get('intercom_contact_update')?.inputSchema?.properties ?? {};
    assert.deepEqual(Object.keys(contactGetProperties).sort(), ['acknowledge_warning', 'contact_id', 'dry_run']);
    assert.deepEqual(Object.keys(contactUpdateProperties).sort(), ['acknowledge_warning', 'contact_id', 'dry_run', 'name']);
    for (const forbidden of ['email', 'phone', 'external_id', 'avatar', 'unsubscribed_from_emails', 'custom_attributes']) {
      assert.equal(Object.hasOwn(contactUpdateProperties, forbidden), false, `COO Chat must not accept ${forbidden}`);
    }

    const otherContact = await connector.callTool('intercom_contact_get', { contact_id: 'another-contact' });
    assert.equal(otherContact.isError, true);
    const wrongName = await connector.callTool('intercom_contact_update', {
      contact_id: '6ab5f0e0843a84e15468a558',
      name: 'Unverified contact name',
      dry_run: false,
    });
    assert.equal(wrongName.isError, true);
    const extraField = await connector.callTool('intercom_contact_update', {
      contact_id: '6ab5f0e0843a84e15468a558',
      name: 'Synthetic Intercom Contact Verification',
      email: 'hidden@example.invalid',
      dry_run: true,
    });
    assert.equal(extraField.isError, undefined, JSON.stringify(extraField));
    const extraFieldResult = extraField.structuredContent as {
      result?: { executed?: boolean; dry_run?: boolean };
    } | undefined;
    assert.deepEqual(extraFieldResult?.result, { executed: false, dry_run: true, contact_id: '6ab5f0e0843a84e15468a558' });
    assert.deepEqual(requests, [], 'rejected or dry-run contact calls must not reach Intercom');

    const update = await connector.callTool('intercom_contact_update', {
      contact_id: '6ab5f0e0843a84e15468a558',
      name: 'Synthetic Intercom Contact Verification',
      dry_run: false,
    });
    assert.equal(update.isError, undefined, JSON.stringify(update));
    const updateResult = update.structuredContent as {
      result?: { executed?: boolean; dry_run?: boolean; contact_id?: string };
    } | undefined;
    assert.deepEqual(updateResult?.result, {
      executed: true,
      dry_run: false,
      contact_id: '6ab5f0e0843a84e15468a558',
    });

    const read = await connector.callTool('intercom_contact_get', {
      contact_id: '6ab5f0e0843a84e15468a558',
    });
    assert.equal(read.isError, undefined, JSON.stringify(read));
    const readResult = read.structuredContent as {
      result?: { contact?: Record<string, unknown> };
    } | undefined;
    assert.deepEqual(readResult?.result?.contact, {
      id: '6ab5f0e0843a84e15468a558',
      name: 'Synthetic Intercom Contact Verification',
    });
    assert.equal(JSON.stringify(read).includes('hidden@example.invalid'), false);
    assert.equal(JSON.stringify(read).includes('custom_attributes'), false);
    assert.deepEqual(requests, [
      {
        method: 'PUT',
        path: '/contacts/6ab5f0e0843a84e15468a558',
        body: { name: 'Synthetic Intercom Contact Verification' },
      },
      {
        method: 'GET',
        path: '/contacts/6ab5f0e0843a84e15468a558',
        body: null,
      },
    ]);
  } finally {
    if (connector) await connector.close();
    globalThis.fetch = originalFetch;
  }
});

test('COO Intercom additions do not widen CRO or external connector lanes', async () => {
  const cro = await bootConnector('cro');
  try {
    const names = new Set((await cro.listTools()).map((tool) => tool.name));
    assert.equal(names.has('intercom_conversation_search'), true, 'CRO keeps its existing Intercom surface');
    for (const name of COO_INTERCOM_WRITE_TOOL_NAMES) {
      assert.equal(names.has(name), false, `COO-specific tool ${name} must not leak to CRO`);
    }
  } finally {
    await cro.close();
  }

  const external = await bootConnector('external-read');
  try {
    const names = new Set((await external.listTools()).map((tool) => tool.name));
    assert.equal([...names].some((name) => name.startsWith('intercom_')), false);
  } finally {
    await external.close();
  }
});
