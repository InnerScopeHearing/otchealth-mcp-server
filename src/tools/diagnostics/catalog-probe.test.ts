import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCatalogProbe } from './catalog-probe.js';

// Pins the 2026-07-26 diagnostic tool built to resolve the M365 Developer agent's live ambiguity:
// is the M365 app not ingesting the new manifest, or is the auth-detection branch broken, or is
// Copilot suppressing tool output regardless of content. This tool must stay tiny and static-shape
// so it can never itself be the thing that's "too big" -- these tests pin that discipline.

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

test('catalog_probe registers under the exact name "catalog_probe"', () => {
  const { server, handlers } = fakeServer();
  registerCatalogProbe(server, () => 'caller-hash');
  assert.ok(handlers.catalog_probe, 'catalog_probe must be registered');
});

test('catalog_probe response is always well under 1KB serialized', async () => {
  const { server, handlers } = fakeServer();
  registerCatalogProbe(server, () => 'caller-hash');
  const result = (await handlers.catalog_probe!({})) as { structuredContent: { result: unknown } };
  const size = Buffer.byteLength(JSON.stringify(result.structuredContent.result), 'utf8');
  assert.ok(size < 1024, `expected under 1KB, got ${size} bytes`);
});

test('catalog_probe surfaces the current request context (caller_agent / m365 / connector flags)', async () => {
  const { server, handlers } = fakeServer();
  registerCatalogProbe(server, () => 'caller-hash');
  const result = (await handlers.catalog_probe!({})) as { structuredContent: { result: { request_context: Record<string, unknown> } } };
  const rc = result.structuredContent.result.request_context;
  assert.ok('caller_agent' in rc);
  assert.ok('is_m365_static_auth' in rc);
  assert.ok('is_connector_surface' in rc);
});

test('catalog_probe reports itself as present in the known_tools_present probe list (self-registration sanity check)', async () => {
  const { server, handlers } = fakeServer();
  registerCatalogProbe(server, () => 'caller-hash');
  const result = (await handlers.catalog_probe!({})) as { structuredContent: { result: { known_tools_present: Record<string, boolean> } } };
  assert.equal(result.structuredContent.result.known_tools_present['catalog_probe'], true);
});
