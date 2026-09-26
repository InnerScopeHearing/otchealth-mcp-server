import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CHAT_SHARED_LANE,
  CHAT_SHARED_TOOLSET,
} from '../config/lane-toolsets.js';
import {
  connectorToolset,
  finalizeM365Aliases,
  registerTool,
  type CallerHashProvider,
  type ToolDefinition,
} from './registry.js';
import { loadEnv } from '../config/env.js';
import { requestContext } from '../server/request-context.js';

const EXPECTED_TOOLS = [...CHAT_SHARED_TOOLSET].sort();
const candidateTools = [
  'brain_search',
  'memory_recall',
  'memory_remember',
  'catalog_probe',
  'gateway_fetch_result',
  'memory_search',
  'memory_write',
  'memory_team',
  'brain_graph_search',
  'kb_search_privileged',
  'legal_blob_get',
  'github_push_files',
  'n8n_create_workflow',
  'connector_setup_code_create',
  'recall',
  'search',
  'probe',
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
  // This hostile shared override must not widen the dedicated shared principal.
  process.env.CONNECTOR_TOOLSET = [
    ...CHAT_SHARED_TOOLSET,
    'memory_search', 'memory_write', 'memory_team', 'brain_graph_search',
    'kb_search_privileged', 'legal_blob_get', 'github_push_files', 'n8n_create_workflow',
    'connector_setup_code_create', 'search', 'recall', 'probe',
  ].join(',');
});

function fakeDef(name: string): ToolDefinition<Record<string, never>, Record<string, never>> {
  const isWrite = name.includes('write') || name.includes('remember') || name.includes('create') || name.includes('push');
  return {
    name,
    category: isWrite ? 'write_simple' : 'read',
    annotations: {
      title: name,
      description: name,
      readOnlyHint: !isWrite,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: {},
    handler: async () => ({ data: null }),
  };
}

function fakeServer(): { server: McpServer; names: string[]; handlers: Map<string, unknown> } {
  const names: string[] = [];
  const handlers = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: unknown) => {
      names.push(name);
      handlers.set(name, handler);
      return {
        remove: () => {
          const index = names.indexOf(name);
          if (index >= 0) names.splice(index, 1);
          handlers.delete(name);
        },
      };
    },
  } as unknown as McpServer;
  return { server, names, handlers };
}

const callerHash: CallerHashProvider = () => 'synthetic-caller-hash';

test('chat_shared connector toolset is exactly fixed regardless of CONNECTOR_TOOLSET override', () => {
  assert.deepEqual([...connectorToolset(loadEnv(), CHAT_SHARED_LANE)].sort(), EXPECTED_TOOLS);
});

test('chat_shared visibility is exactly the commons Brain set across DCR, confidential, and M365 auth contexts', () => {
  const contexts = [
    { connectorSurface: true, m365StaticAuth: false, description: 'DCR/connector token' },
    { connectorSurface: false, m365StaticAuth: false, description: 'confidential OAuth token' },
    { connectorSurface: false, m365StaticAuth: true, description: 'M365 static token' },
  ];

  for (const context of contexts) {
    const { server, names, handlers } = fakeServer();
    requestContext.run({
      callerHash: 'synthetic-caller-hash',
      correlationId: 'synthetic-correlation',
      callerAgent: CHAT_SHARED_LANE,
      connectorSurface: context.connectorSurface,
      m365StaticAuth: context.m365StaticAuth,
    }, () => {
      for (const name of candidateTools) registerTool(server, fakeDef(name), callerHash);
      finalizeM365Aliases(server, callerHash);
    });

    assert.deepEqual([...names].sort(), EXPECTED_TOOLS, `${context.description} must get exactly the shared toolset`);
    assert.deepEqual([...handlers.keys()].sort(), EXPECTED_TOOLS, `${context.description} must not register forbidden direct calls`);
  }
});
