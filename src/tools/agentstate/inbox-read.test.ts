import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

process.env.CIO_SITE_ID ??= 'test';
process.env.CIO_TRACK_KEY ??= 'test';
process.env.CIO_APP_API_BEARER ??= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
process.env.STATE_BACKEND = 'cosmos';
process.env.AGENT_INBOX_STORAGE_ACCOUNT = 'testaccount';
process.env.AGENT_INBOX_STORAGE_KEY = Buffer.alloc(32).toString('base64');

const { registerInboxRead } = await import('./inbox-read.js');

function fakeServer(): {
  server: McpServer;
  handlers: Record<string, (args: unknown) => Promise<unknown>>;
  configs: Record<string, { inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }> }>;
} {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const configs: Record<string, { inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }> }> = {};
  const server = {
    registerTool: (name: string, config: typeof configs[string], handler: (args: unknown) => Promise<unknown>) => {
      configs[name] = config;
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { server, handlers, configs };
}

test('inbox_read keeps max bounded to 1..32 and exposes newest_first as optional boolean', () => {
  const { server, configs } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');
  const shape = configs.inbox_read!.inputSchema;
  assert.equal(shape.max.safeParse(1).success, true);
  assert.equal(shape.max.safeParse(32).success, true);
  assert.equal(shape.max.safeParse(0).success, false);
  assert.equal(shape.max.safeParse(33).success, false);
  assert.equal(shape.newest_first.safeParse(true).success, true);
  assert.equal(shape.newest_first.safeParse('true').success, false);
});

test('newest_first rejects drains and identifies Azure backend as unsupported', async () => {
  const { server, handlers } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');

  const drain = await handlers.inbox_read!({ agent: 'developer', newest_first: true });
  assert.equal((drain as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(drain), /only for live read-only peeks/);

  const azurePeek = await handlers.inbox_read!({ agent: 'developer', ack: false, newest_first: true });
  assert.equal((azurePeek as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(azurePeek), /unsupported by the active Azure Queue backend/);
});

test('over-limit inbox_read requests fail validation before touching the queue', async () => {
  const { server, handlers } = fakeServer();
  registerInboxRead(server, () => 'inbox-read-test');
  const result = await handlers.inbox_read!({ agent: 'developer', max: 33 });
  assert.equal((result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(result), /Invalid input/);
});
