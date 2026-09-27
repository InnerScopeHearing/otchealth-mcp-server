import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  connectorToolset,
  finalizeM365Aliases,
  registerTool,
  type CallerHashProvider,
  type ToolDefinition,
} from './registry.js';
import { loadEnv } from '../config/env.js';
import { requestContext } from '../server/request-context.js';

const PILOT_LANE = 'cto-make-github-pilot';
const EXPECTED_TOOLS = ['catalog_probe', 'github_make_broker'];

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

  // Deliberately hostile shared override. The pilot lane must ignore this global setting and
  // return its exact two-tool contract in the same function registerTool() consumes.
  process.env.CONNECTOR_TOOLSET = [
    'catalog_probe', 'github_make_broker', 'github_push_files', 'github_create_branch', 'github_edit_file',
    'github_pr_update', 'github_merge_pull_request', 'github_get_file_contents', 'gateway_fetch_result',
    'push_files', 'create_branch', 'edit_file', 'kb_search_privileged', 'legal_blob_get', 'memory_write',
    'memory_remember', 'wake', 'connector_setup_code_create',
  ].join(',');
});

const candidateTools = [
  'catalog_probe',
  'github_make_broker',
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
  'github_merge_pull_request',
  'github_get_file_contents',
  'gateway_fetch_result',
  'push_files',
  'create_branch',
  'edit_file',
  'kb_search_privileged',
  'legal_blob_get',
  'memory_write',
  'memory_remember',
  'wake',
  'connector_setup_code_create',
] as const;

function fakeDef(name: string): ToolDefinition<Record<string, never>, Record<string, never>> {
  const isWrite = name.includes('write') || name.includes('create') || name.includes('update') || name.includes('edit') || name.includes('push') || name.includes('merge');
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

const callerHash: CallerHashProvider = () => 'test-hash';

test('pilot tool visibility is exactly broker plus probe for DCR, confidential/static, and M365 token contexts', () => {
  const env = loadEnv();
  assert.deepEqual([...connectorToolset(env, PILOT_LANE)].sort(), EXPECTED_TOOLS);

  const contexts = [
    { connectorSurface: true, m365StaticAuth: false, description: 'DCR/connector token' },
    { connectorSurface: false, m365StaticAuth: false, description: 'confidential/client-credentials token' },
    { connectorSurface: false, m365StaticAuth: true, description: 'M365 static token' },
  ];

  for (const context of contexts) {
    const { server, names, handlers } = fakeServer();
    requestContext.run({
      callerHash: 'test-hash',
      correlationId: 'test-correlation',
      callerAgent: PILOT_LANE,
      connectorSurface: context.connectorSurface,
      m365StaticAuth: context.m365StaticAuth,
    }, () => {
      for (const name of candidateTools) registerTool(server, fakeDef(name), callerHash);
      finalizeM365Aliases(server, callerHash);
    });

    assert.deepEqual([...names].sort(), EXPECTED_TOOLS, `${context.description} must get the exact pilot set`);
    assert.deepEqual([...handlers.keys()].sort(), EXPECTED_TOOLS, `${context.description} must not register forbidden direct calls`);
    for (const forbidden of [
      'github_push_files', 'github_create_branch', 'github_edit_file', 'github_pr_update', 'github_merge_pull_request',
      'gateway_fetch_result', 'push_files', 'create_branch', 'edit_file', 'kb_search_privileged', 'legal_blob_get',
      'memory_write', 'memory_remember', 'wake', 'connector_setup_code_create', 'probe', 'make_broker',
    ]) {
      assert.equal(handlers.has(forbidden), false, `${context.description} must deny ${forbidden}`);
    }
  }
});
