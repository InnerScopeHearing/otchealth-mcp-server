import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectorToolset, CTO_SHIP_LANE_TOOLSET, registerTool } from './registry.js';
import { loadEnv, type Env } from '../config/env.js';
import { requestContext } from '../server/request-context.js';

// CI diagnostics belong to the CTO and Developer delivery lanes. All other roles stay excluded;
// the handler separately enforces the company-owner/PHI boundaries and redacts retained output.
const TOOL = 'github_workflow_run_failed_log_excerpt';

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

test('registered CI reader admits Developer through execution governance and refuses unrelated roles', async () => {
  type Handler = (args: Record<string, unknown>) => Promise<any>;
  let handler: Handler | undefined;
  let calls = 0;
  const server = {
    registerTool(_name: string, _config: unknown, candidate: Handler) {
      handler = candidate;
      return { remove() {} };
    },
  } as unknown as McpServer;
  registerTool(server, {
    name: TOOL,
    category: 'read',
    annotations: { title: 'Synthetic CI diagnostic', description: 'Synthetic admission test', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: { owner: z.string(), repo: z.string() },
    outputShape: { admitted: z.boolean() },
    handler: async () => { calls++; return { data: { admitted: true } }; },
  }, () => 'ci-admission-fixture');
  assert.ok(handler);
  const invoke = (callerAgent: string) => requestContext.run({ callerHash: 'ci-admission-fixture', correlationId: 'ci-admission-fixture', callerAgent },
    () => handler!({ owner: 'InnerScopeHearing', repo: 'aware-aural-rehab' }));
  const accepted = await invoke('developer');
  assert.equal(calls, 1, JSON.stringify(accepted));
  assert.notEqual(accepted.isError, true);
  const denied = await invoke('cfo');
  assert.equal(calls, 1, 'denied role must not reach the handler');
  assert.equal(denied.structuredContent?.error?.code, 'forbidden_role');
});

test('the CI log excerpt reader is advertised only to CTO and Developer delivery lanes', () => {
  assert.equal(CTO_SHIP_LANE_TOOLSET.includes(TOOL), false, 'CTO-only reader must not be in the shared ship set');
  assert.equal(connectorToolset(loadEnv(), 'cto').has(TOOL), true);
  assert.equal(connectorToolset(loadEnv(), 'developer').has(TOOL), true);
  for (const lane of ['cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'external-read']) {
    assert.equal(connectorToolset(loadEnv(), lane).has(TOOL), false, lane);
  }
  const overridden = { ...loadEnv(), CONNECTOR_TOOLSET: 'brain_search' } as Env;
  assert.equal(connectorToolset(overridden, 'cto').has(TOOL), false, 'an explicit CONNECTOR_TOOLSET override keeps its exact meaning');
  assert.equal(connectorToolset(overridden, 'developer').has(TOOL), false, 'Developer preserves explicit override semantics');
});
