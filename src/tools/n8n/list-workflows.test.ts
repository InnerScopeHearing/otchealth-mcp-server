import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'c'.repeat(32);
process.env.N8N_API_KEY = 'test-n8n-key';
process.env.N8N_BASE_URL = 'https://cs-n8n.otchealthmart.com';

const { registerN8nListWorkflows } = await import('./list-workflows.js');
const { __resetN8nReachabilityCache } = await import('../../n8n/reachability.js');

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

type RegisteredHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureListHandler(): RegisteredHandler {
  let captured: RegisteredHandler | undefined;
  const server = {
    registerTool: (_name: string, _config: Record<string, unknown>, handler: RegisteredHandler) => {
      captured = handler;
      return { remove() {} };
    },
  } as unknown as McpServer;

  registerN8nListWorkflows(server, () => 'test-caller-hash');
  assert.ok(captured, 'n8n_list_workflows should register its handler');
  return captured;
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function callListTool(
  body: unknown,
  input: Record<string, unknown> = {},
): Promise<{ response: ToolResult; urls: string[] }> {
  __resetN8nReachabilityCache();
  const handler = captureListHandler();
  const urls: string[] = [];
  const response = await withFetch(
    (async (inputUrl: string | URL | Request) => {
      const url = String(inputUrl);
      urls.push(url);
      if (url.endsWith('/healthz')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch,
    () => handler(input),
  );
  return { response, urls };
}

function resultData(response: ToolResult): Record<string, unknown> {
  const structured = response.structuredContent;
  assert.ok(structured && typeof structured === 'object');
  const result = structured.result;
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  return result as Record<string, unknown>;
}

test('n8n_list_workflows preserves its filters and returns an allowlisted metadata projection', async () => {
  const apiFields = {
    id: 'wf-1',
    name: 'Safe display name',
    active: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    tags: [{ id: 'tag-1', name: 'operations', credentials: 'TAG_CREDENTIAL_SENTINEL' }],
    nodes: [{ name: 'private node', credentials: { apiKey: 'NODE_SECRET_SENTINEL' } }],
    connections: { private: 'CONNECTION_SENTINEL' },
    settings: { saveDataErrorExecution: 'SETTINGS_SENTINEL' },
    staticData: { private: 'STATIC_DATA_SENTINEL' },
    credentials: { apiKey: 'CREDENTIALS_SENTINEL' },
    credentialMetadata: { name: 'CREDENTIAL_METADATA_SENTINEL' },
    credential: { token: 'CREDENTIAL_SENTINEL' },
  };
  const { response, urls } = await callListTool(
    { data: [apiFields], nextCursor: 'next-cursor' },
    { active: true, limit: 100, cursor: 'cursor-1', name: 'customer', tag: 'production' },
  );

  assert.equal(response.isError, undefined);
  assert.deepEqual(resultData(response), {
    workflows: [{
      id: 'wf-1',
      name: 'Safe display name',
      active: true,
      tags: [{ id: 'tag-1', name: 'operations' }],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    }],
    count: 1,
    next_cursor: 'next-cursor',
  });
  const serialized = JSON.stringify(response);
  for (const marker of [
    'TAG_CREDENTIAL_SENTINEL', 'NODE_SECRET_SENTINEL', 'CONNECTION_SENTINEL',
    'SETTINGS_SENTINEL', 'STATIC_DATA_SENTINEL', 'CREDENTIALS_SENTINEL',
    'CREDENTIAL_METADATA_SENTINEL', 'CREDENTIAL_SENTINEL',
  ]) {
    assert.equal(serialized.includes(marker), false, `${marker} must not be returned`);
  }

  const requestUrl = new URL(urls.find((url) => url.includes('/api/v1/workflows'))!);
  assert.deepEqual([...requestUrl.searchParams.entries()], [
    ['active', 'true'],
    ['limit', '100'],
    ['cursor', 'cursor-1'],
    ['name', 'customer'],
    ['tags', 'production'],
  ]);
});

test('n8n_list_workflows applies its documented default page size', async () => {
  const { response, urls } = await callListTool({ data: [{ id: 'wf-default' }] });

  assert.equal(response.isError, undefined);
  const requestUrl = new URL(urls.find((url) => url.includes('/api/v1/workflows'))!);
  assert.equal(requestUrl.searchParams.get('limit'), '100');
  assert.deepEqual(resultData(response), {
    workflows: [{ id: 'wf-default' }],
    count: 1,
    next_cursor: null,
  });
});

test('n8n_list_workflows fails closed when n8n returns more records than requested', async () => {
  const { response } = await callListTool(
    { data: [{ id: 'wf-1' }, { id: 'wf-2' }], nextCursor: 'next-cursor' },
    { limit: 1 },
  );

  assert.equal(response.isError, true);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('wf-2'), false);
  assert.match(serialized, /invalid workflow list metadata/);
});

test('n8n_list_workflows rejects a page limit above 250 before making an n8n request', async () => {
  const { response, urls } = await callListTool({ data: [] }, { limit: 251 });

  assert.equal(response.isError, true);
  assert.equal(urls.some((url) => url.includes('/api/v1/workflows')), false);
});

test('n8n_list_workflows drops oversized non-allowlisted workflow data before measuring the response', async () => {
  const marker = 'OVERSIZED_NODE_DATA_SENTINEL';
  const largeForbiddenFields = marker + 'x'.repeat(1_011_416);
  const { response } = await callListTool({
    data: [{
      id: 'wf-large',
      name: 'Safe name',
      active: false,
      nodes: largeForbiddenFields,
      connections: largeForbiddenFields,
      settings: largeForbiddenFields,
      credentials: largeForbiddenFields,
    }],
  });

  const serialized = JSON.stringify(response);
  assert.equal(response.isError, undefined);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 64 * 1024);
  assert.equal(serialized.includes(marker), false);
  assert.deepEqual(resultData(response), {
    workflows: [{ id: 'wf-large', name: 'Safe name', active: false }],
    count: 1,
    next_cursor: null,
  });
});

test('n8n_list_workflows fails closed when allowlisted metadata exceeds 64 KiB', async () => {
  const marker = 'OVERSIZED_DISPLAY_NAME_SENTINEL';
  const { response } = await callListTool({
    data: [{ id: 'wf-large', name: marker + 'x'.repeat(70 * 1024) }],
  });

  assert.equal(response.isError, true);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(marker), false);
  assert.match(serialized, /exceeded its configured size limit/);
});

test('n8n_list_workflows returns a redacted error when n8n throws upstream details', async () => {
  __resetN8nReachabilityCache();
  const handler = captureListHandler();
  const marker = 'UPSTREAM_PRIVATE_ERROR_SENTINEL';
  const response = await withFetch(
    (async (inputUrl: string | URL | Request) => {
      const url = String(inputUrl);
      if (url.endsWith('/healthz')) return new Response('ok', { status: 200 });
      throw new Error(marker);
    }) as unknown as typeof fetch,
    () => handler({ active: true, limit: 100 }),
  );

  assert.equal(response.isError, true);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(marker), false);
  assert.match(serialized, /Unable to list n8n workflow metadata safely/);
});
