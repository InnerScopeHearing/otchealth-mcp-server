import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { getExactMemory, searchMemory, type MemoryRecord } from '../../agentstate/memory.js';

process.env.CIO_SITE_ID = 'test';
process.env.CIO_TRACK_KEY = 'test';
process.env.CIO_APP_API_BEARER = 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN = 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN = 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET = 'c'.repeat(32);
const { registerMemorySearch } = await import('./memory-search.js');

const record: MemoryRecord = { id: 'm_test', type: 'memory', agent: 'cto', kind: 'status', text: 'synthetic', tags: [], source: null, created_at: '2026-01-01' };
function setup(configured: boolean, row: unknown, fail = false) {
  let reads = 0;
  let handler!: (args: unknown) => Promise<any>;
  const server = { registerTool: (_name: string, _config: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  registerMemorySearch(server, () => 'test', {
    isConfigured: () => configured,
    search: (input) => searchMemory(input, (id, agent) => getExactMemory(id, agent, async () => {
      reads++;
      if (fail) throw new Error('synthetic provider details');
      return row === null ? null : { doc: row as Record<string, unknown>, etag: null };
    })),
  });
  return { invoke: (args: unknown) => requestContext.run({ callerAgent: 'cto', callerHash: 'test', correlationId: 'test', authKind: 'codex' }, () => handler(args)), reads: () => reads };
}

test('registered tool exposes unconfigured, denied, successful hit and actual miss', async () => {
  const unconfigured = setup(false, record);
  const u = await unconfigured.invoke({ id: record.id });
  assert.equal(u.structuredContent.result.status, 'unconfigured');
  assert.equal(u.structuredContent.result.lookup_performed, false);
  assert.equal(unconfigured.reads(), 0);
  const denied = setup(true, record);
  const d = await denied.invoke({ agent: 'cfo', id: record.id });
  assert.equal(d.structuredContent.result.status, 'denied');
  assert.equal(d.structuredContent.result.lookup_performed, false);
  assert.equal(d.structuredContent.result.blocked, true);
  assert.equal(denied.reads(), 0);
  for (const row of [record, null]) {
    const s = setup(true, row);
    const response = await s.invoke({ id: record.id });
    assert.equal(response.structuredContent.result.status, 'success');
    assert.equal(response.structuredContent.result.lookup_performed, true);
    assert.equal(response.structuredContent.result.count, row ? 1 : 0);
    assert.equal(s.reads(), 1);
  }
});

test('registered exact invalid inputs and non-exact failures retain their error identity', async () => {
  const s = setup(true, record);
  const invalidId = await s.invoke({ id: '../bad' });
  assert.equal(invalidId.isError, true);
  assert.match(invalidId.structuredContent.error.message, /invalid id/);
  const invalidAgent = await s.invoke({ id: record.id, agent: 'invalid agent' });
  assert.equal(invalidAgent.isError, true);
  assert.match(invalidAgent.structuredContent.error.message, /invalid agent/);
  assert.equal(s.reads(), 0);

  let handler!: (args: unknown) => Promise<any>;
  const server = { registerTool: (_name: string, _config: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer;
  registerMemorySearch(server, () => 'test', { isConfigured: () => true, search: async () => { throw new Error('existing non-exact failure'); } });
  const result = await requestContext.run({ callerAgent: 'cto', callerHash: 'test', correlationId: 'test', authKind: 'codex' }, () => handler({ contains: 'test' }));
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.message, 'existing non-exact failure');
});

test('registered tool preserves failures and never discloses corrupt row or provider details', async () => {
  for (const [row, fail, expected] of [[record, true, 'memory_search_provider_failure'], [{ ...record, text: 'private synthetic sentinel', agent: 'other' }, false, 'memory_record_corrupt']] as const) {
    const s = setup(true, row, fail);
    const response = await s.invoke({ id: record.id });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.result, null);
    assert.equal(response.structuredContent.error.message, expected);
    assert.doesNotMatch(JSON.stringify(response), /private synthetic sentinel|synthetic provider details/);
    assert.equal(s.reads(), 1);
  }
});
