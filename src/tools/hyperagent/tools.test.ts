import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WEFUNDER_CAMPAIGN_DIRECTOR_LANE as WEFUNDER_LANE, WEFUNDER_SOURCE_AGENT_ID as WEFUNDER_ID } from './ring.js';

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
  HYPERAGENT_LANE_AGENTS: `cto=agent-general,agent-exec,${WEFUNDER_ID};coo=agent-general,agent-exec;cro=agent-general,agent-exec;${WEFUNDER_LANE}=${WEFUNDER_ID},agent-exec,other-wefunder,agent-general`,
  HYPERAGENT_AGENT_CLASSES: `agent-general=general;agent-unassigned=general;agent-exec=exec;${WEFUNDER_ID}=exec;other-wefunder=exec`,
});

const { requestContext } = await import('../../server/request-context.js');
const { registerHyperagentTools, sanitizeHyperagentCapabilities } = await import('./tools.js');
const { __resetInvocationBudgetForTests } = await import('./rate-limit.js');
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

async function invoke(tool: CapturedTool, args: Record<string, unknown>, callerAgent = 'cto'): Promise<Response> {
  return requestContext.run(
    { callerHash: 'synthetic-hash', correlationId: 'synthetic-correlation', callerAgent },
    () => tool.handler(args),
  );
}

function resultOf(response: Response): Record<string, unknown> {
  const result = response.structuredContent?.result;
  assert.ok(result && typeof result === 'object');
  return result as Record<string, unknown>;
}

test('capability discovery returns only validated tool schemas and declared paging fields', async () => {
  const provider = {
    tools: [{
      name: 'list_threads',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: { type: 'string' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          agentId: { type: 'string' },
        },
        required: ['cursor'],
        additionalProperties: false,
      },
    }],
  };
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', {
    configured: () => true,
    call: async () => { throw new Error('capability discovery must not call tools/call'); },
    listCapabilities: async () => ({ ok: true, status: 200, data: provider }),
  });
  const response = await invoke(tools.get('hyperagent_discover_capabilities')!, {});
  assert.deepEqual(resultOf(response), {
    ok: true,
    tools: [{
      name: 'list_threads',
      inputSchema: provider.tools[0].inputSchema,
      declaredPaging: [
        { name: 'cursor', type: 'string', required: true },
        { name: 'pageSize', type: 'integer', required: false },
      ],
    }],
    omittedUnsupportedSchemas: 0,
  });
});

test('capability discovery is CTO-only and provider failures never return provider text', async () => {
  const { server, tools } = fakeServer();
  let calls = 0;
  registerHyperagentTools(server, () => 'synthetic-hash', {
    configured: () => true,
    call: async () => ({ ok: true, status: 200, data: null }),
    listCapabilities: async () => {
      calls += 1;
      return { ok: false, status: 503, data: null, error: 'private provider details' };
    },
  });
  const forbidden = await invoke(tools.get('hyperagent_discover_capabilities')!, {}, WEFUNDER_LANE);
  assert.deepEqual(resultOf(forbidden), { ok: false, error: 'forbidden_lane' });
  assert.equal(calls, 0);
  const failed = await invoke(tools.get('hyperagent_discover_capabilities')!, {});
  assert.deepEqual(resultOf(failed), { ok: false, error: 'provider_error' });
  assert.equal(JSON.stringify(failed).includes('private provider details'), false);
  assert.equal(calls, 1);
});

test('capability discovery refuses unsafe and oversized schema shapes', () => {
  const unsafeName = sanitizeHyperagentCapabilities({ tools: [{ name: 'list_threads', inputSchema: { type: 'object', description: 'must not pass through' } }] });
  assert.deepEqual(unsafeName, { ok: true, tools: [], omittedUnsupportedSchemas: 1 });
  const oversized = sanitizeHyperagentCapabilities({ tools: Array.from({ length: 65 }, () => ({ name: 'list_threads', inputSchema: { type: 'object' } })) });
  assert.deepEqual(oversized, { ok: false, error: 'unsafe_capabilities_metadata' });
  const unsafeReference = sanitizeHyperagentCapabilities({ tools: [{ name: 'list_threads', inputSchema: { type: 'object', properties: { cursor: { $ref: '#/unsafe' } } } }] });
  assert.deepEqual(unsafeReference, { ok: true, tools: [], omittedUnsupportedSchemas: 1 });
  const sourceSpecificEnum = sanitizeHyperagentCapabilities({
    tools: [
      { name: 'list_agents', inputSchema: { type: 'object' } },
      { name: 'private_source_tool', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['private-source-value'] } } } },
    ],
  });
  assert.deepEqual(sourceSpecificEnum, {
    ok: true,
    tools: [{ name: 'list_agents', inputSchema: { type: 'object' }, declaredPaging: [] }],
    omittedUnsupportedSchemas: 1,
  });
  assert.equal(JSON.stringify(sourceSpecificEnum).includes('private_source_tool'), false);
  assert.equal(JSON.stringify(sourceSpecificEnum).includes('private-source-value'), false);
});

test('capability discovery projects required descriptor fields while dropping provider metadata', () => {
  const privateMarker = 'PRIVATE_PROVIDER_DESCRIPTION_MARKER';
  const result = sanitizeHyperagentCapabilities({
    tools: [{
      name: 'list_threads',
      description: privateMarker,
      annotations: { title: privateMarker, readOnlyHint: true },
      inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } },
    }],
  });
  assert.deepEqual(result, {
    ok: true,
    tools: [{ name: 'list_threads', inputSchema: { type: 'object', properties: { cursor: { type: 'string' } } }, declaredPaging: [{ name: 'cursor', type: 'string', required: false }] }],
    omittedUnsupportedSchemas: 0,
  });
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});

test('capability discovery falls back only to fixed named primitive thread metadata', () => {
  const marker = 'PRIVATE_PROVIDER_DESCRIPTION_MARKER';
  const result = sanitizeHyperagentCapabilities({ tools: [
    { name: 'list_threads', inputSchema: { type: 'object', description: marker, properties: {
      cursor: { type: 'string', default: marker }, limit: { type: 'integer', description: marker }, nested: { type: 'object', properties: {} },
    }, required: ['limit'] } },
    { name: 'get_thread', inputSchema: { type: 'object', $schema: marker, properties: { threadId: { type: 'string', description: marker } }, required: ['threadId'] } },
    { name: 'create_thread', inputSchema: { type: 'object', description: marker, properties: { agentId: { type: 'string' } } } },
  ] });
  assert.deepEqual(result, { ok: true, tools: [], omittedUnsupportedSchemas: 3, fixedNamedInputs: [
    { name: 'list_threads', inputs: [{ name: 'cursor', type: 'string', required: false }, { name: 'limit', type: 'integer', required: true }] },
    { name: 'get_thread', inputs: [{ name: 'threadId', type: 'string', required: true }] },
  ] });
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(JSON.stringify(result).includes('nested'), false);
});

// Exercise the real registry connector filter and the resulting guarded handlers. Transport is
// synthetic throughout; adding catalog visibility must not grant a new source or executive ring.
function registerConnectorBroker(lane: string, transport: HyperagentToolTransport) {
  const fixture = fakeServer();
  requestContext.run(
    { callerHash: 'synthetic-hash', correlationId: 'synthetic-correlation', callerAgent: lane, connectorSurface: true },
    () => registerHyperagentTools(fixture.server, () => 'synthetic-hash', transport),
  );
  return fixture.tools;
}

for (const lane of ['coo', 'cro']) {
  test(`${lane} connector registers five broker tools and reads its assigned general source`, async () => {
    const payload = { thread: { id: 'owned-thread', namedAgentId: 'agent-general' }, messages: [] };
    const { transport, calls } = fakeTransport(async () => ({ ok: true, status: 200, data: payload }));
    const tools = registerConnectorBroker(lane, transport);
    assert.deepEqual([...tools.keys()].sort(), [
      'hyperagent_create_thread', 'hyperagent_get_thread', 'hyperagent_list_agents',
      'hyperagent_list_threads', 'hyperagent_send_message',
    ]);
    const response = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'owned-thread' }, lane);
    assert.deepEqual(resultOf(response), { ok: true, thread: payload });
    assert.deepEqual(calls, [{ name: 'get_thread', args: { threadId: 'owned-thread' } }]);
  });

  test(`${lane} connector still refuses executive, unassigned, conflicting and ownerless get/send`, async () => {
    for (const owner of [
      { id: 'blocked-thread', namedAgentId: 'agent-exec' },
      { id: 'blocked-thread', namedAgentId: 'agent-unassigned' },
      { id: 'blocked-thread', namedAgentId: 'agent-general', agentId: 'agent-exec' },
      { id: 'blocked-thread' },
    ]) {
      const { transport, calls } = fakeTransport(async name => {
        assert.equal(name, 'get_thread', 'denied writes must never reach the provider');
        return { ok: true, status: 200, data: { thread: owner, messages: [{ content: 'blocked-fleet-marker' }] } };
      });
      const tools = registerConnectorBroker(lane, transport);
      for (const toolName of ['hyperagent_get_thread', 'hyperagent_send_message']) {
        assert.ok(tools.has(toolName), 'test the registered connector handler');
        const args = toolName === 'hyperagent_get_thread' ? { threadId: 'blocked-thread' }
          : { threadId: 'blocked-thread', message: 'synthetic follow up' };
        const response = await invoke(tools.get(toolName)!, args, lane);
        assert.equal(resultOf(response).ok, false);
        assert.equal(JSON.stringify(response).includes('blocked-fleet-marker'), false);
      }
      assert.deepEqual(calls.map(call => call.name), ['get_thread', 'get_thread']);
    }
  });

  test(`${lane} connector create refuses executive and unassigned sources without provider calls`, async () => {
    const { transport, calls } = fakeTransport(async () => { throw new Error('provider must not be called'); });
    const tools = registerConnectorBroker(lane, transport);
    assert.ok(tools.has('hyperagent_create_thread'));
    for (const agentId of ['agent-exec', 'agent-unassigned']) {
      const response = await invoke(tools.get('hyperagent_create_thread')!, { agentId, message: 'synthetic task' }, lane);
      assert.equal(resultOf(response).ok, false);
    }
    assert.deepEqual(calls, []);
  });
}

test('external and unknown connectors receive no Hyperagent broker tools', () => {
  const { transport, calls } = fakeTransport(async () => { throw new Error('provider must not be called'); });
  for (const lane of ['external-read', '', 'unknown-fleet-seat']) {
    assert.equal(registerConnectorBroker(lane, transport).size, 0, lane);
  }
  assert.deepEqual(calls, []);
});

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

test('dedicated source read is allowed while CTO read of identical payload stays denied', async () => {
  const payload = { thread: { id: 'source-thread', namedAgentId: WEFUNDER_ID }, messages: [{ content: 'synthetic-source-content' }] };
  const { transport } = fakeTransport(async () => ({ ok: true, status: 200, data: payload }));
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', transport);
  const own = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'source-thread' }, WEFUNDER_LANE);
  assert.deepEqual(resultOf(own), { ok: true, thread: payload });
  const cto = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'source-thread' });
  assert.deepEqual(resultOf(cto), { ok: false, error: 'forbidden_ring' });
  assert.equal(JSON.stringify(cto).includes('synthetic-source-content'), false);
});

test('dedicated get/send refuse other owners, unresolved owners, conflicts and wrong thread identity without content or writes', async () => {
  for (const owner of [
    { id: 'blocked-thread', namedAgentId: 'other-wefunder' },
    { id: 'blocked-thread', namedAgentId: 'agent-exec' },
    { id: 'blocked-thread', namedAgentId: 'agent-general' },
    { id: 'blocked-thread' },
    { id: 'blocked-thread', namedAgentId: WEFUNDER_ID, agentId: 'agent-exec' },
    { id: 'wrong-thread', namedAgentId: WEFUNDER_ID },
  ]) {
    const { transport, calls } = fakeTransport(async name => {
      assert.equal(name, 'get_thread');
      return { ok: true, status: 200, data: { thread: owner, messages: [{ content: 'blocked-synthetic-marker' }] } };
    });
    const { server, tools } = fakeServer();
    registerHyperagentTools(server, () => 'synthetic-hash', transport);
    for (const toolName of ['hyperagent_get_thread', 'hyperagent_send_message']) {
      const args = toolName === 'hyperagent_get_thread' ? { threadId: 'blocked-thread' }
        : { threadId: 'blocked-thread', message: 'prepare export' };
      const response = await invoke(tools.get(toolName)!, args, WEFUNDER_LANE);
      assert.equal(resultOf(response).ok, false, JSON.stringify(owner));
      assert.equal(JSON.stringify(response).includes('blocked-synthetic-marker'), false);
    }
    assert.deepEqual(calls.map(call => call.name), ['get_thread', 'get_thread']);
  }
});

test('dedicated listings contain only the exact source and its verified threads', async () => {
  const ownAgent = { id: WEFUNDER_ID, name: 'Wefunder Campaign Director' };
  const ownThread = { id: 'own-thread', namedAgentId: WEFUNDER_ID };
  const { transport } = fakeTransport(async name => ({ ok: true, status: 200, data: name === 'list_agents'
    ? { agents: [ownAgent, { id: 'other-wefunder', name: 'hidden-other-marker' }, { id: 'agent-exec', name: 'hidden-other-marker' }] }
    : { threads: [ownThread, { id: 'hidden-other-marker', namedAgentId: 'agent-exec' }, { id: 'hidden-other-marker' }] } }));
  const { server, tools } = fakeServer();
  registerHyperagentTools(server, () => 'synthetic-hash', transport);
  const agents = await invoke(tools.get('hyperagent_list_agents')!, {}, WEFUNDER_LANE);
  const threads = await invoke(tools.get('hyperagent_list_threads')!, {}, WEFUNDER_LANE);
  assert.deepEqual(resultOf(agents).agents, [ownAgent]);
  assert.deepEqual(resultOf(threads).threads, [ownThread]);
  assert.equal(JSON.stringify([agents, threads]).includes('hidden-other-marker'), false);
});

test('dedicated create/send share invocation budget and never write to any other assigned source', async () => {
  __resetInvocationBudgetForTests();
  const previousLimit = process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR;
  process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR = '2';
  try {
    const { transport, calls } = fakeTransport(async (name, args) => ({ ok: true, status: 200, data: name === 'get_thread'
      ? { thread: { id: args.threadId, namedAgentId: WEFUNDER_ID } }
      : name === 'create_thread' ? { threadId: 'export-thread' } : {} }));
    const { server, tools } = fakeServer();
    registerHyperagentTools(server, () => 'synthetic-hash', transport);
    const denied = await invoke(tools.get('hyperagent_create_thread')!, { agentId: 'other-wefunder', message: 'prepare export' }, WEFUNDER_LANE);
    assert.equal(resultOf(denied).error, 'forbidden_ring');
    assert.equal(calls.length, 0);
    const created = await invoke(tools.get('hyperagent_create_thread')!, { agentId: WEFUNDER_ID, message: 'prepare export' }, WEFUNDER_LANE);
    assert.equal(resultOf(created).ok, true);
    const sent = await invoke(tools.get('hyperagent_send_message')!, { threadId: 'export-thread', message: 'report export manifest' }, WEFUNDER_LANE);
    assert.equal(resultOf(sent).ok, true);
    const limited = await invoke(tools.get('hyperagent_send_message')!, { threadId: 'export-thread', message: 'another run' }, WEFUNDER_LANE);
    assert.equal(resultOf(limited).error, 'rate_limited');
    assert.deepEqual(calls.map(call => call.name), ['create_thread', 'get_thread', 'send_message', 'get_thread']);
    const preview = await invoke(tools.get('hyperagent_create_thread')!, { agentId: WEFUNDER_ID, message: 'preview only', dry_run: true }, WEFUNDER_LANE);
    assert.equal((preview.structuredContent as { dry_run?: boolean }).dry_run, true);
    assert.equal(calls.length, 4, 'dry-run must not spend or call the provider');
  } finally {
    if (previousLimit === undefined) delete process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR;
    else process.env.HYPERAGENT_MAX_INVOCATIONS_PER_HOUR = previousLimit;
    __resetInvocationBudgetForTests();
  }
});

test('dedicated source grant gives no private finance/legal Brain rooms', async () => {
  const { roomsFor, OPEN_ROOMS } = await import('../kb/brain-search.js');
  assert.deepEqual(roomsFor(WEFUNDER_LANE).sort(), [...OPEN_ROOMS].sort());
  assert.deepEqual(roomsFor(WEFUNDER_LANE, 'finance'), []);
  assert.deepEqual(roomsFor(WEFUNDER_LANE, 'legal'), []);
});

test('dedicated wake refuses other agents and large source replies never touch the unscoped result store', async () => {
  const { registerWake } = await import('../memory/wake.js');
  const { loadEnv } = await import('../../config/env.js');
  const { shouldOffload } = await import('../result-store.js');
  const fixtureEnv = loadEnv();
  const previousConfig = { STATE_BACKEND: fixtureEnv.STATE_BACKEND,
    COSMOS_ENDPOINT: fixtureEnv.COSMOS_ENDPOINT, COSMOS_KEY: fixtureEnv.COSMOS_KEY };
  Object.assign(fixtureEnv, { STATE_BACKEND: 'cosmos', COSMOS_ENDPOINT: 'https://synthetic-storage.invalid',
    COSMOS_KEY: Buffer.from('synthetic-storage-key').toString('base64') });
  let ioCount = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    ioCount += 1;
    throw new Error('Synthetic test forbids all network IO');
  });
  try {
    const { server, tools } = fakeServer();
    registerWake(server, () => 'synthetic-hash');
    for (const agent of ['cfo', 'clo', 'clo-personal', 'cto']) {
      const denied = await invoke(tools.get('wake')!, { agent }, WEFUNDER_LANE);
      assert.deepEqual(resultOf(denied).errors, ['forbidden_agent']);
      assert.deepEqual(resultOf(denied).memory_records, []);
    }
    assert.equal(ioCount, 0, 'foreign wake must stop before any storage lookup');
    const payload = { thread: { id: 'large-source', namedAgentId: WEFUNDER_ID }, messages: [{ content: 'synthetic-large-body'.repeat(4000) }] };
    assert.equal(shouldOffload(JSON.stringify(payload)), true, 'positive control: configured synthetic storage would offload this payload');
    const { transport } = fakeTransport(async () => ({ ok: true, status: 200, data: payload }));
    registerHyperagentTools(server, () => 'synthetic-hash', transport);
    const result = await invoke(tools.get('hyperagent_get_thread')!, { threadId: 'large-source' }, WEFUNDER_LANE);
    assert.deepEqual(resultOf(result), { ok: true, thread: payload });
    assert.equal(ioCount, 0, 'large result must remain inline and must not enter shared cache');
  } finally {
    fetchMock.mock.restore();
    Object.assign(fixtureEnv, previousConfig);
  }
});

test('dedicated principal is curated even for a legacy non-connector auth path', async () => {
  const { registerTool } = await import('../registry.js');
  const { z } = await import('zod');
  for (const connectorSurface of [false, true]) {
    const { server, tools } = fakeServer();
    requestContext.run({ callerAgent: WEFUNDER_LANE, callerHash: 'synthetic', correlationId: 'synthetic', connectorSurface }, () => {
      for (const name of ['gateway_fetch_result', 'kb_get_document', 'memory_write', 'legal_blob_get', 'wake']) {
        registerTool(server, { name, category: 'read', annotations: { title: name, description: name,
          readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputShape: {}, outputShape: { ok: z.boolean() }, handler: async () => ({ data: { ok: true }, summary: 'synthetic' }) }, () => 'synthetic');
      }
    });
    assert.deepEqual([...tools.keys()], ['wake']);
  }
});

test('source write log and episode projections contain only identifiers and message length', async () => {
  const { logger } = await import('../../audit/logger.js');
  const { buildEpisodeText, redactArgs } = await import('../../safety/journal.js');
  const { hyperagentInvocationMetadata } = await import('./tools.js');
  const captured: unknown[] = [];
  const logMock = mock.method(logger, 'info', (...args: unknown[]) => { captured.push(args); });
  const marker = 'PRIVATE_SYNTHETIC_EXPORT_PROMPT_MARKER';
  __resetInvocationBudgetForTests();
  try {
    const { transport } = fakeTransport(async (name, args) => ({ ok: true, status: 200, data: name === 'get_thread'
      ? { thread: { id: args.threadId, namedAgentId: WEFUNDER_ID } } : { threadId: 'synthetic-export' } }));
    const { server, tools } = fakeServer();
    registerHyperagentTools(server, () => 'synthetic-hash', transport);
    for (const [name, args] of [
      ['hyperagent_create_thread', { agentId: WEFUNDER_ID, message: marker }],
      ['hyperagent_send_message', { threadId: 'synthetic-export', message: marker }],
    ] as const) {
      assert.equal(resultOf(await invoke(tools.get(name)!, args, WEFUNDER_LANE)).ok, true);
      const episode = buildEpisodeText({ tool: name, actor: WEFUNDER_LANE, outcome: 'success',
        redactedArgs: redactArgs(name, hyperagentInvocationMetadata(args)) });
      assert.equal(episode.includes(marker), false);
      assert.equal(episode.includes('message_chars'), true);
    }
    assert.ok(captured.length > 0);
    assert.equal(JSON.stringify(captured).includes(marker), false, 'actual tool start/end logs must omit the prompt');
  } finally {
    logMock.mock.restore();
    __resetInvocationBudgetForTests();
  }
});
