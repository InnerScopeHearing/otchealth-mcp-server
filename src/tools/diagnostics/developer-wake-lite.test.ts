import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDeveloperWakeLite } from './developer-wake-lite.js';

// Pins the 2026-07-26 diagnostic tool built after wake()'s own M365-lite branch still returned
// "NO CONTENT AVAILABLE" live in the M365 Developer agent even with recent_limit=1/memory_limit=1/
// task_limit=1. This tool has zero fan-out and zero branching so it can definitively separate
// "wake()'s own logic has a bug" from "the client suppresses ANY tool output regardless of size".

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

function fakeServer(): { server: McpServer; handlers: Record<string, (args: unknown) => Promise<unknown>> } {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<unknown>) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { server, handlers };
}

test('developer_wake_lite registers under the exact name "developer_wake_lite"', () => {
  const { server, handlers } = fakeServer();
  registerDeveloperWakeLite(server, () => 'caller-hash');
  assert.ok(handlers.developer_wake_lite, 'developer_wake_lite must be registered');
});

test('developer_wake_lite response is always well under 1KB serialized, regardless of input', async () => {
  const { server, handlers } = fakeServer();
  registerDeveloperWakeLite(server, () => 'caller-hash');
  const result = (await handlers.developer_wake_lite!({})) as { structuredContent: { result: unknown } };
  const size = Buffer.byteLength(JSON.stringify(result.structuredContent.result), 'utf8');
  assert.ok(size < 1024, `expected under 1KB, got ${size} bytes`);
});

test('developer_wake_lite echoes the agent input when provided', async () => {
  const { server, handlers } = fakeServer();
  registerDeveloperWakeLite(server, () => 'caller-hash');
  const result = (await handlers.developer_wake_lite!({ agent: 'developer' })) as { structuredContent: { result: { agent: string } } };
  assert.equal(result.structuredContent.result.agent, 'developer');
});

test('developer_wake_lite falls back to "(unknown)" when no agent input and no caller identity', async () => {
  const { server, handlers } = fakeServer();
  registerDeveloperWakeLite(server, () => 'caller-hash');
  const result = (await handlers.developer_wake_lite!({})) as { structuredContent: { result: { agent: string } } };
  assert.equal(result.structuredContent.result.agent, '(unknown)');
});

test('developer_wake_lite always includes is_m365_static_auth and caller_agent fields (never throws building them)', async () => {
  const { server, handlers } = fakeServer();
  registerDeveloperWakeLite(server, () => 'caller-hash');
  const result = (await handlers.developer_wake_lite!({})) as { structuredContent: { result: Record<string, unknown> } };
  assert.ok('is_m365_static_auth' in result.structuredContent.result);
  assert.ok('caller_agent' in result.structuredContent.result);
});
