import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track',
  CIO_APP_API_BEARER: 'synthetic-app',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(32),
  N8N_WEBHOOK_SECRET: 'n'.repeat(32),
  READ_ONLY_MODE: 'false',
  ENABLE_WRITE_TOOLS: 'true',
  ENABLE_HIGH_RISK_TOOLS: 'true',
  DRY_RUN_DEFAULT: 'false',
  NODE_ENV: 'test',
  COLD_START_MODE: 'off',
  SHIELD_MODE: 'off',
  GROUNDEDNESS_MODE: 'off',
  AUTO_JOURNAL_MODE: 'off',
  HYPERAGENT_LANE_AGENTS: 'cto=agent-general,agent-exec',
  HYPERAGENT_AGENT_CLASSES: 'agent-general=general;agent-exec=exec',
});

const { requestContext } = await import('../../server/request-context.js');
const { registerHyperagentTools } = await import('./tools.js');
type HyperagentToolTransport = import('./tools.js').HyperagentToolTransport;

interface Response {
  structuredContent?: { result?: unknown };
  [key: string]: unknown;
}
interface CapturedTool {
  handler: (args: unknown) => Promise<Response>;
}

function fakeServer(): { server: McpServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  return {
    server: {
      registerTool(name: string, _config: unknown, handler: CapturedTool['handler']) {
        tools.set(name, { handler });
        return { remove: () => tools.delete(name) };
      },
    } as unknown as McpServer,
    tools,
  };
}

function fakeTransport(
  respond: HyperagentToolTransport['call'],
): { transport: HyperagentToolTransport; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    transport: {
      configured: () => true,
      call: async (name, args) => {
        calls.push({ name, args });
        return respond(name, args);
      },
    },
  };
}

async function invoke(tool: CapturedTool, args: Record<string, unknown>): Promise<Response> {
  return requestContext.run(
    { callerHash: 'synthetic-hash', correlationId: 'synthetic-correlation', callerAgent: 'cto' },
    () => tool.handler(args),
  );
}

function resultOf(response: Response): Record<string, unknown> {
  const result = response.structuredContent?.result;
  assert.ok(result && typeof result === 'object');
  return result as Record<string, unknown>;
}

test('get_thread permits current namedAgentId shape with exact thread id and ring match', async () => {
  const provider = {
    thread: { id: 'thread-current', name: 'Allowed title', namedAgentId: 'agent-general' },
    messages: [{ role: 'assistant', content: 'allowed-provider-message' }],
    isRunning: false,
  };
  const { transport, calls } = fakeTransport(async (name) => {
    assert.equal(name, 'get_thread');
    return { ok: true, status: 200, data: provider };
  });
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', transport);

  const response = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'thread-current' });

  assert.deepEqual(resultOf(response), { ok: true, thread: provider });
  assert.deepEqual(calls, [{ name: 'get_thread', args: { threadId: 'thread-current' } }]);
});

test('get_thread owner denial returns no provider messages or content', async () => {
  const { transport } = fakeTransport(async () => ({
    ok: true,
    status: 200,
    data: {
      thread: { id: 'thread-denied', name: 'denied-title-41f', namedAgentId: 'agent-exec' },
      messages: [{ content: 'denied-message-41f' }],
      internalContent: 'denied-content-41f',
    },
  }));
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', transport);

  const response = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'thread-denied' });

  assert.deepEqual(resultOf(response), { ok: false, error: 'forbidden_ring' });
  const visible = JSON.stringify(response);
  for (const marker of ['denied-title-41f', 'denied-message-41f', 'denied-content-41f']) {
    assert.equal(visible.includes(marker), false, marker);
  }
});

test('send_message denial never invokes the provider write or returns probe content', async () => {
  for (const [label, probe] of [
    ['restricted', { thread: { id: 'thread-denied', namedAgentId: 'agent-exec' }, messages: [{ content: 'restricted-probe-7c3' }] }],
    ['conflict', { thread: { id: 'thread-denied', namedAgentId: 'agent-general', agentId: 'agent-exec' }, messages: [{ content: 'conflict-probe-7c3' }] }],
  ] as const) {
    const { transport, calls } = fakeTransport(async (name) => {
      assert.equal(name, 'get_thread', label);
      return { ok: true, status: 200, data: probe };
    });
    const { server, tools } = fakeServer();
    registerHyperagentTools(server, () => 'synthetic-hash', transport);

    const response = await invoke(tools.get('hyperagent_send_message')!, {
      threadId: 'thread-denied',
      message: 'synthetic follow up',
    });

    assert.deepEqual(calls.map((call) => call.name), ['get_thread'], label);
    assert.equal(calls.some((call) => call.name === 'send_message'), false, label);
    assert.equal(JSON.stringify(response).includes('probe-7c3'), false, label);
    assert.equal(resultOf(response).ok, false, label);
  }
});

test('list_threads omits denied, conflicting, and ownerless title and content', async () => {
  const allowed = {
    id: 'thread-allowed',
    name: 'Allowed title',
    namedAgentId: 'agent-general',
    preview: 'allowed-list-content',
  };
  const upstream = [
    allowed,
    { id: 'thread-restricted', name: 'restricted-title-9d2', namedAgentId: 'agent-exec', preview: 'restricted-content-9d2' },
    { id: 'thread-conflict', name: 'conflict-title-9d2', namedAgentId: 'agent-general', agentId: 'agent-exec', preview: 'conflict-content-9d2' },
    { id: 'thread-ownerless', name: 'ownerless-title-9d2', preview: 'ownerless-content-9d2' },
  ];
  const { transport, calls } = fakeTransport(async (name) => {
    assert.equal(name, 'list_threads');
    return { ok: true, status: 200, data: { threads: upstream } };
  });
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', transport);

  const response = await invoke(tools.get('hyperagent_list_threads')!, {});
  const result = resultOf(response);

  assert.deepEqual(result.threads, [allowed]);
  assert.equal(result.count, 1);
  assert.equal(result.total_upstream, 4);
  assert.equal(result.omitted, 3);
  assert.deepEqual(calls.map((call) => call.name), ['list_threads']);
  const visible = JSON.stringify(response);
  for (const marker of [
    'restricted-title-9d2',
    'restricted-content-9d2',
    'conflict-title-9d2',
    'conflict-content-9d2',
    'ownerless-title-9d2',
    'ownerless-content-9d2',
  ]) assert.equal(visible.includes(marker), false, marker);
});