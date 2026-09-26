import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  filterRecallAgentScope,
  registerMemoryRecall,
  resolveMemoryRecallScope,
} from './recall.js';
import { requestContext } from '../../server/request-context.js';

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
  process.env.CONNECTOR_TOOLSET = 'memory_recall';
});

function connectorInputSchema(callerAgent: string): Record<string, unknown> {
  let inputSchema: Record<string, unknown> | undefined;
  const server = {
    registerTool(_name: string, config: { inputSchema: Record<string, unknown> }) {
      inputSchema = config.inputSchema;
      return { remove() {} };
    },
  };
  requestContext.run(
    {
      callerHash: 'synthetic-caller-hash',
      correlationId: 'synthetic-correlation',
      callerAgent,
      connectorSurface: true,
      m365StaticAuth: false,
    },
    () => registerMemoryRecall(server as unknown as McpServer, () => 'synthetic-caller-hash'),
  );
  assert.ok(inputSchema);
  return inputSchema;
}

test('chat_shared recall always resolves to commons and allows an explicit commons filter', () => {
  assert.deepEqual(resolveMemoryRecallScope('chat_shared'), {
    agentFilter: 'commons',
    directSharedFeed: true,
  });
  assert.deepEqual(resolveMemoryRecallScope('chat_shared', 'COMMONS'), {
    agentFilter: 'commons',
    directSharedFeed: true,
  });
});

test('chat_shared recall refuses other and malformed feed selectors', () => {
  for (const requested of ['cto', 'clo-personal', '../invalid']) {
    const scope = resolveMemoryRecallScope('chat_shared', requested);
    assert.equal(scope.agentFilter, 'commons');
    assert.equal(scope.directSharedFeed, true);
    assert.equal(scope.refusalMode, 'fixed-scope-forbidden');
    assert.match(scope.refusal ?? '', /restricted to the commons feed/);
  }
});

test('chat_shared response filtering drops rows outside commons even if a search backend returns them', () => {
  const scope = resolveMemoryRecallScope('chat_shared');
  const hits = [
    { id: 'commons-1', agent: 'commons' },
    { id: 'commons-2', agent: ' COMMONS ' },
    { id: 'cto-1', agent: 'cto' },
    { id: 'personal-1', agent: 'clo-personal' },
    { id: 'missing-agent' },
  ];
  assert.deepEqual(filterRecallAgentScope(hits, scope).map((hit) => hit.id), ['commons-1', 'commons-2']);
});

test('other company lanes retain the established optional recall behavior', () => {
  const scope = resolveMemoryRecallScope('cto');
  const hits = [{ agent: 'commons' }, { agent: 'cto' }];
  assert.equal(scope.directSharedFeed, false);
  assert.deepEqual(filterRecallAgentScope(hits, scope), hits);
  assert.deepEqual(resolveMemoryRecallScope('cto', 'cto'), {
    agentFilter: 'cto',
    directSharedFeed: false,
  });
  assert.equal(resolveMemoryRecallScope('cto', 'clo-personal').refusalMode, 'ring-forbidden');
});

test('chat_shared connector schema omits the agent selector while ordinary CTO retains it', () => {
  const sharedSchema = connectorInputSchema('chat_shared');
  const ctoSchema = connectorInputSchema('cto');
  assert.equal(Object.hasOwn(sharedSchema, 'agent'), false);
  assert.equal(Object.hasOwn(ctoSchema, 'agent'), true);
});
