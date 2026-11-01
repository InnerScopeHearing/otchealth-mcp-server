import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

process.env.CIO_SITE_ID ||= 'test'; process.env.CIO_TRACK_KEY ||= 'test'; process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'a'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ||= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'c'.repeat(32); process.env.N8N_API_KEY = 'test'; process.env.N8N_BASE_URL = 'https://cs-n8n.otchealthmart.com';
process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = 'w1,w2';

const { registerN8nCooWorkflowMetadata } = await import('./coo-workflow-metadata.js');
const { __resetN8nReachabilityCache } = await import('../../n8n/reachability.js');
const { requestContext } = await import('../../server/request-context.js');

type Result = { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
function handler(): Handler {
  let found: Handler | undefined;
  const server = { registerTool: (_n: string, _c: Record<string, unknown>, h: Handler) => { found = h; return { remove() {} }; } } as unknown as McpServer;
  registerN8nCooWorkflowMetadata(server, () => 'test-caller'); assert.ok(found); return found;
}
async function call(responses: Record<string, unknown>, callerAgent = 'coo', input: Record<string, unknown> = {}) {
  __resetN8nReachabilityCache(); const h = handler(); const urls: string[] = []; const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = new URL(String(u)); urls.push(url.toString());
    if (url.pathname.endsWith('/healthz')) return new Response('ok');
    const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    if (!(id in responses)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(responses[id]));
  }) as typeof fetch;
  try { return { result: await requestContext.run({ callerHash: 'test-caller', correlationId: 'test-correlation', callerAgent }, () => h(input)), urls }; }
  finally { globalThis.fetch = original; }
}
function data(result: Result): Record<string, unknown> { return result.structuredContent!.result as Record<string, unknown>; }

describe('COO workflow metadata', { concurrency: false }, () => {
test('COO reader requests exact allowlisted IDs and returns only approved metadata fields', async () => {
  const secret = 'SENSITIVE_WORKFLOW_SENTINEL';
  const { result, urls } = await call({
    w1: { id: 'w1', name: secret, active: true, createdAt: '2026-10-31T09:15:00.000Z', updatedAt: '2026-10-31T09:16:00Z', tags: [secret], nodes: secret, credentials: secret, connections: secret },
    w2: { id: 'w2', active: false },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(data(result), { workflows: [
    { id: 'w1', active: true, createdAt: '2026-10-31T09:15:00.000Z', updatedAt: '2026-10-31T09:16:00Z' },
    { id: 'w2', active: false },
  ], count: 2, next_offset: null });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(urls.filter((u) => u.includes('/api/v1/workflows/')).map((u) => new URL(u).pathname).sort(), ['/api/v1/workflows/w1', '/api/v1/workflows/w2']);
});

test('missing, empty, malformed, duplicate, or excessive allowlist fails before n8n probe/request', async () => {
  const original = process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
  try {
    for (const value of [undefined, '', 'bad id', 'w1,w1', Array.from({ length: 26 }, (_, i) => `w${i}`).join(',')]) {
      if (value === undefined) delete process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
      else process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = value;
      const { result, urls } = await call({});
      assert.equal(result.isError, true); assert.equal(urls.length, 0);
    }
  } finally { process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = original; }
});

test('non-COO caller is rejected by registry authorization without an upstream call', async () => {
  const { result, urls } = await call({}, 'cro');
  assert.equal(result.isError, true); assert.match(JSON.stringify(result), /restricted to the coo agent/);
  assert.equal(urls.length, 0);
});

test('upstream response for a requested ID cannot substitute another workflow ID', async () => {
  const { result } = await call({ w1: { id: 'outside-scope', active: true }, w2: { id: 'w2' } });
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('outside-scope'), false);
});

test('server allowlist pagination uses bounded offsets, only pages authorized IDs, and has an empty terminal page', async () => {
  const original = process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
  try {
    const ids = Array.from({ length: 7 }, (_, i) => `w${i + 1}`);
    process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = ids.join(',');
    const responses = Object.fromEntries(ids.map((id) => [id, { id, active: true }]));
    const first = await call(responses, 'coo', { offset: 0 });
    assert.deepEqual(data(first.result), { workflows: ids.slice(0, 2).map((id) => ({ id, active: true })), count: 2, next_offset: 2 });
    assert.equal(first.urls.filter((u) => u.includes('/api/v1/workflows/')).length, 2);
    const second = await call(responses, 'coo', { offset: 2 });
    assert.deepEqual(data(second.result), { workflows: ids.slice(2, 4).map((id) => ({ id, active: true })), count: 2, next_offset: 4 });
    assert.equal(second.urls.filter((u) => u.includes('/api/v1/workflows/')).length, 2);
    const third = await call(responses, 'coo', { offset: 4 });
    assert.deepEqual(data(third.result), { workflows: ids.slice(4, 6).map((id) => ({ id, active: true })), count: 2, next_offset: 6 });
    const final = await call(responses, 'coo', { offset: 6 });
    assert.deepEqual(data(final.result), { workflows: ids.slice(6).map((id) => ({ id, active: true })), count: 1, next_offset: null });
    const empty = await call(responses, 'coo', { offset: 7 });
    assert.deepEqual(data(empty.result), { workflows: [], count: 0, next_offset: null });
    assert.equal(empty.urls.length, 0);
    const invalid = await call(responses, 'coo', { offset: 8 });
    assert.equal(invalid.result.isError, true); assert.equal(invalid.urls.length, 0);
  } finally { process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = original; }
});

test('missing or malformed workflow metadata fails closed without returning partial results', async () => {
  for (const responses of [
    { w1: { id: 'w1', active: 'yes' }, w2: { id: 'w2' } },
    { w1: { id: 'w1', createdAt: 'arbitrary text' }, w2: { id: 'w2' } },
    { w1: { id: 'w1', updatedAt: 'x'.repeat(41) }, w2: { id: 'w2' } },
    { w1: { id: 'w1' } },
  ]) {
    const { result } = await call(responses);
    assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('w1'), false);
  }
});

test('missing configured workflow fails closed without partial results', async () => {
  const original = process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST;
  try {
    process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = 'w1,w2';
    const missing = await call({ w1: { id: 'w1' } }); assert.equal(missing.result.isError, true);
    assert.equal(missing.urls.filter((u) => u.includes('/api/v1/workflows/')).length, 2);
    assert.equal(JSON.stringify(missing.result).includes('w1'), false);
  } finally { process.env.COO_N8N_WORKFLOW_ID_ALLOWLIST = original; }
});
});
