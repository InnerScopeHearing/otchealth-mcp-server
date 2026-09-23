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
  'intercom_ticket_type_update',
] as const;

const COO_INTERCOM_DENIED_TOOL_NAMES = [
  'intercom_contact_search',
  'intercom_conversation_search',
  'intercom_ticket_search',
  'intercom_event_list',
  'intercom_note_list',
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
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

async function bootConnector(lane: string): Promise<ConnectorHarness> {
  const { registerAllTools } = await import('./index.js');
  const { requestContext } = await import('../server/request-context.js');
  const context = {
    callerHash: `test-${lane}`,
    correlationId: `test-${lane}-correlation`,
    callerAgent: lane,
    connectorSurface: true,
  };
  const server = new McpServer(
    { name: `test-${lane}-connector`, version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );

  await requestContext.run(context, async () => {
    registerAllTools(server, () => context.callerHash);
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
    for (const name of ['intercom_admin_set_away', 'intercom_ticket_type_update']) {
      assert.deepEqual(byName.get(name)?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
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

test('COO Intercom additions do not widen CRO or external connector lanes', async () => {
  const cro = await bootConnector('cro');
  try {
    const names = new Set((await cro.listTools()).map((tool) => tool.name));
    assert.equal(names.has('intercom_conversation_search'), true, 'CRO keeps its existing Intercom surface');
    assert.equal(names.has('intercom_admin_set_away'), false);
    assert.equal(names.has('intercom_ticket_type_update'), false);
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
