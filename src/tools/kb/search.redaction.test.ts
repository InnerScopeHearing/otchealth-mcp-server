import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKbSearch } from './search.js';
import { requestContext } from '../../server/request-context.js';

before(() => {
  process.env.CIO_SITE_ID ||= 'test';
  process.env.CIO_TRACK_KEY ||= 'test';
  process.env.CIO_APP_API_BEARER ||= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ||= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ||= 'c'.repeat(32);
});

test('registered kb_search sanitizes an unknown-index early return without calling a search backend', async () => {
  let registered: ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  const server = {
    registerTool: (_name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
      registered = handler;
      return { remove() {} };
    },
  } as unknown as McpServer;

  await requestContext.run(
    { callerHash: 'synthetic-hash', correlationId: 'synthetic-correlation', callerAgent: 'cto' },
    async () => registerKbSearch(server, () => 'synthetic-hash'),
  );
  assert.ok(registered);

  const response = await requestContext.run(
    { callerHash: 'synthetic-hash', correlationId: 'synthetic-correlation', callerAgent: 'cto' },
    () => registered!({ index: 'unknown "api_key=SYNTHETIC_INDEX_SENTINEL"', query: 'synthetic query' }),
  );
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /SYNTHETIC_INDEX_SENTINEL/);
  assert.match(serialized, /\[REDACTED: explicitly labeled secret\]/);
  const result = response.structuredContent as { result: { count: number; mode: string } };
  assert.equal(result.result.count, 0);
  assert.equal(result.result.mode, 'unknown-index');
});
