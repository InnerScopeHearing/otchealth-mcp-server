/**
 * AWS bridge output is never offloaded to the shared result cache.
 *
 * When a tool result is large, the registry can store the whole payload in the shared result cache and
 * return a stub with a result id. The bridge keeps its output inline: it is already capped, and account
 * data must not be written to shared storage. This file proves that instead of assuming it. The offload
 * threshold is set low, storage looks configured, the caller hash is valid (so an offload attempt would
 * reach storage), and a CONTROL tool of the same size does offload. A bridge result that stays inline
 * under those conditions is the exclusion at work, not an accident of size or configuration.
 *
 * Own file (own process): the threshold is read when result-store.ts loads and loadEnv() memoizes.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const THRESHOLD = 3000;
const STORAGE_HOST = 'https://synthetic-storage.invalid';

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track',
  CIO_APP_API_BEARER: 'synthetic-app',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(32),
  N8N_WEBHOOK_SECRET: 'n'.repeat(32),
  READ_ONLY_MODE: 'true',
  ENABLE_WRITE_TOOLS: 'false',
  ENABLE_HIGH_RISK_TOOLS: 'false',
  DRY_RUN_DEFAULT: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  COLD_START_MODE: 'off',
  SHIELD_MODE: 'off',
  GROUNDEDNESS_MODE: 'off',
  AUTO_JOURNAL_MODE: 'off',
  // Storage that looks configured, and a threshold far below what the bridge returns.
  STATE_BACKEND: 'cosmos',
  COSMOS_ENDPOINT: STORAGE_HOST,
  COSMOS_DB: 'synthetic',
  COSMOS_KEY: Buffer.from('synthetic-storage-key').toString('base64'),
  JIT_RESULT_THRESHOLD_CHARS: String(THRESHOLD),
});
delete process.env.AWS_AI_READER_ROLE_ARN;
delete process.env.AWS_MCP_BRIDGE_DISABLED;

const { requestContext } = await import('../../server/request-context.js');
const { registerTool } = await import('../registry.js');
const { mayOffloadToolResult, shouldOffload } = await import('../result-store.js');
const bridge = await import('./tools.js');
type FetchLike = import('./signed-fetch.js').FetchLike;

const CALLER_HASH = 'c0ffee'.repeat(10) + 'c0ff';

interface WrapperResponse {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: { result?: Record<string, unknown> | null; error?: { code: string; message: string } };
}
interface CapturedTool {
  handler: (args: unknown) => Promise<WrapperResponse>;
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

/** A minimal AWS MCP Server over a mocked fetch: one session, then a tools/call or tools/list answer. */
function fakeAwsMcp(opts: { callText?: string; tools?: unknown[] }): FetchLike {
  return async (_url, init) => {
    if (String(init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 200 });
    const rpc = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    const reply = (result: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
    switch (rpc.method) {
      case 'initialize':
        return reply(
          { protocolVersion: (rpc.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-aws-mcp', version: '0.0.0' } },
          { 'mcp-session-id': 'sess-1' },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return reply({ tools: opts.tools ?? [] });
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: opts.callText ?? 'ok' }] });
      default:
        return new Response(null, { status: 405 });
    }
  };
}

const READER = {
  accessKeyId: 'ASIA' + 'SYNTHETICRD00001',
  secretAccessKey: 'synthetic-reader-secret-1',
  sessionToken: 'synthetic-reader-session-token-1',
  roleArn: 'arn:aws:iam::111122223333:role/otchealth-ai-reader-role',
  roleSessionName: 'gw-cto-nooffload',
};

/** Storage as the registry would reach it: every request to the synthetic storage host is counted. */
function installStorage() {
  const storageRequests: Array<{ method: string; url: string }> = [];
  const otherRequests: string[] = [];
  const spy = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith(STORAGE_HOST)) storageRequests.push({ method: String(init?.method ?? 'GET'), url: target });
    else otherRequests.push(target);
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  });
  return { storageRequests, otherRequests, restore: () => spy.mock.restore() };
}

function invoke(tool: CapturedTool, args: Record<string, unknown>): Promise<WrapperResponse> {
  return requestContext.run(
    { callerHash: CALLER_HASH, correlationId: 'corr-no-offload-0001', callerAgent: 'cto', authKind: 'oauth', authGrant: 'authorization_code', authSubject: 'occ_fixture' },
    () => tool.handler(args),
  );
}

function registerControlTool(server: McpServer): void {
  registerTool(
    server,
    {
      name: 'synthetic_control_read',
      category: 'read',
      annotations: { title: 'control', description: 'control', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputShape: {},
      outputShape: { rows: z.string() },
      handler: async () => ({ data: { rows: 'row of listing output\n'.repeat(1_000) }, summary: 'control result' }),
    },
    () => CALLER_HASH,
  );
}

test('the offload threshold and storage are live in this process, and the bridge tools are excluded by name', () => {
  assert.equal(shouldOffload('x'.repeat(THRESHOLD + 1)), true, 'a result over the threshold would be offloaded');
  assert.equal(shouldOffload('x'.repeat(THRESHOLD - 1)), false);
  assert.equal(mayOffloadToolResult('aws_mcp_tool_call'), false);
  assert.equal(mayOffloadToolResult('aws_mcp_tool_list'), false);
  assert.equal(mayOffloadToolResult('synthetic_control_read'), true);
});

test('CONTROL: an oversized result from an ordinary read tool IS offloaded to storage, so this setup would catch an offload', async () => {
  const storage = installStorage();
  try {
    const { server, tools } = fakeServer();
    registerControlTool(server);
    const response = await invoke(tools.get('synthetic_control_read')!, {});
    assert.equal(response.isError, undefined, response.content?.[0].text);
    assert.equal(response.structuredContent?.result?._jit_offloaded, true, 'the control result was replaced by an offload stub');
    assert.match(String(response.structuredContent?.result?.result_id), /^jitres/);
    assert.ok(storage.storageRequests.length >= 1, 'the offload wrote to storage');
    assert.ok(storage.storageRequests.some((r) => r.method === 'POST' && r.url.includes('/colls/cache/docs')));
  } finally {
    storage.restore();
  }
});

test('aws_mcp_tool_call never offloads a result far above the threshold, and writes nothing to storage', async () => {
  const storage = installStorage();
  try {
    const callText = 'row of listing output\n'.repeat(1_000); // about 22 KB, under the bridge cap and over the threshold
    const { server, tools } = fakeServer();
    bridge.registerAwsMcpTools(server, () => CALLER_HASH, { getCredentials: async () => READER, fetchImpl: fakeAwsMcp({ callText }) });
    const response = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___run_script', arguments: { script: 'print(1)' } });

    assert.equal(response.isError, undefined, response.content?.[0].text);
    const text = response.content?.[0].text ?? '';
    assert.ok(text.length > THRESHOLD * 4, `the inline text (${text.length} chars) is far above the offload threshold`);
    assert.equal(shouldOffload(text), true, 'the registry would have offloaded this text had the tool not been excluded');
    assert.equal(response.structuredContent?.result?._jit_offloaded, undefined, 'no offload stub');
    assert.equal(response.structuredContent?.result?.result_id, undefined);
    assert.equal(response.structuredContent?.result?.content_text, callText, 'the full output is returned inline');
    assert.deepEqual(storage.storageRequests, [], 'nothing was written to or read from storage');
    assert.doesNotMatch(text, /JIT: this result|gateway_fetch_result/);
  } finally {
    storage.restore();
  }
});

test('aws_mcp_tool_list never offloads a large tool list, and writes nothing to storage', async () => {
  const storage = installStorage();
  try {
    const many = Array.from({ length: 40 }, (_unused, i) => ({
      name: `aws___tool_${i}`,
      description: 'Describes what the upstream tool does. '.repeat(10),
      inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'argument a' } } },
    }));
    const { server, tools } = fakeServer();
    bridge.registerAwsMcpTools(server, () => CALLER_HASH, { getCredentials: async () => READER, fetchImpl: fakeAwsMcp({ tools: many }) });
    const response = await invoke(tools.get('aws_mcp_tool_list')!, {});

    assert.equal(response.isError, undefined, response.content?.[0].text);
    const text = response.content?.[0].text ?? '';
    assert.ok(text.length > THRESHOLD * 2, `the inline text (${text.length} chars) is far above the offload threshold`);
    assert.equal(shouldOffload(text), true, 'the registry would have offloaded this text had the tool not been excluded');
    assert.equal(response.structuredContent?.result?._jit_offloaded, undefined, 'no offload stub');
    assert.ok(Array.isArray(response.structuredContent?.result?.tools));
    assert.deepEqual(storage.storageRequests, [], 'nothing was written to or read from storage');
  } finally {
    storage.restore();
  }
});

test('a bridge failure and a bridge refusal are returned inline as well, with no storage use', async () => {
  const storage = installStorage();
  try {
    const { server, tools } = fakeServer();
    bridge.registerAwsMcpTools(server, () => CALLER_HASH, { getCredentials: async () => READER, fetchImpl: fakeAwsMcp({}) });
    const blocked = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___get_presigned_url' });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content?.[0].text ?? '', /aws_mcp_tool_blocked/);
    assert.deepEqual(storage.storageRequests, []);
  } finally {
    storage.restore();
  }
});
