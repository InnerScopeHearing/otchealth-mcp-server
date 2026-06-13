import '../../test-helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../index.js';
import { getRegisteredTools } from '../registry.js';

type CapturedHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent?: { result?: unknown };
  isError?: boolean;
}>;

/**
 * Minimal stub matching the one McpServer method our registry uses
 * (registerTool(name, config, handler)). It captures each tool's handler so the
 * test can invoke catalog tools directly without standing up a transport.
 */
function makeStubServer(): { server: McpServer; handlers: Map<string, CapturedHandler> } {
  const handlers = new Map<string, CapturedHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: CapturedHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

async function callTool(handlers: Map<string, CapturedHandler>, name: string, args: Record<string, unknown> = {}) {
  const handler = handlers.get(name);
  assert.ok(handler, `tool ${name} was not registered`);
  const res = await handler!(args);
  assert.notEqual(res.isError, true, `tool ${name} returned an error`);
  return res.structuredContent?.result as Record<string, unknown>;
}

test('registerAllTools registers Depot, PostHog, and Catalog tools', () => {
  const { server } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const names = new Set(getRegisteredTools().map((t) => t.name));
  for (const expected of [
    'depot_list_projects',
    'depot_list_builds',
    'depot_get_build',
    'depot_get_usage',
    'depot_list_cache_usage',
    'depot_reset_cache',
    'posthog_list_projects',
    'posthog_list_insights',
    'posthog_get_insight',
    'posthog_list_feature_flags',
    'posthog_get_feature_flag',
    'posthog_list_experiments',
    'posthog_list_annotations',
    'posthog_list_cohorts',
    'catalog_list_tools',
    'catalog_service_capabilities',
    'catalog_audit_unused',
  ]) {
    assert.ok(names.has(expected), `expected tool ${expected} to be registered`);
  }
});

test('catalog_list_tools groups every tool by service', async () => {
  const { server, handlers } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const result = await callTool(handlers, 'catalog_list_tools');
  const services = result.services as Array<{ service: string; tools: Array<{ name: string; access: string }> }>;
  const serviceNames = services.map((s) => s.service);
  assert.ok(serviceNames.includes('depot'));
  assert.ok(serviceNames.includes('posthog'));
  assert.ok(serviceNames.includes('catalog'));
  assert.ok(serviceNames.includes('customerio'), 'cio_* tools should map to the customerio service');
  // The destructive Depot tool must be reported as destructive, not read.
  const depot = services.find((s) => s.service === 'depot');
  const reset = depot?.tools.find((t) => t.name === 'depot_reset_cache');
  assert.equal(reset?.access, 'destructive');
  assert.ok((result.tool_count as number) >= 17);
});

test('catalog_list_tools filters to one service', async () => {
  const { server, handlers } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const result = await callTool(handlers, 'catalog_list_tools', { service: 'posthog' });
  const services = result.services as Array<{ service: string }>;
  assert.equal(services.length, 1);
  assert.equal(services[0]?.service, 'posthog');
});

test('catalog_service_capabilities splits WIRED vs AVAILABLE-NOT-WIRED with no drift', async () => {
  const { server, handlers } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const result = await callTool(handlers, 'catalog_service_capabilities', { service: 'depot' });
  assert.equal(result.service, 'depot');
  assert.ok((result.wired as unknown[]).length > 0);
  assert.ok((result.available_not_wired as unknown[]).length > 0);
  // Manifest's wired toolNames must all be registered -> no drift.
  assert.equal((result.drift as unknown[]).length, 0, `unexpected drift: ${JSON.stringify(result.drift)}`);
});

test('catalog_service_capabilities reports drift for an unknown service', async () => {
  const { server, handlers } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const result = await callTool(handlers, 'catalog_service_capabilities', { service: 'nope' });
  assert.ok((result.drift as Array<{ issue: string }>).some((d) => d.issue === 'unknown_service'));
});

test('catalog_audit_unused returns the features-on-the-table list and hides PHI carve-outs by default', async () => {
  const { server, handlers } = makeStubServer();
  registerAllTools(server, () => 'test-caller');
  const def = await callTool(handlers, 'catalog_audit_unused');
  assert.ok((def.unused_count as number) > 0);
  assert.equal((def.intentionally_never_wired as unknown[]).length, 0);

  const withIntentional = await callTool(handlers, 'catalog_audit_unused', { include_intentional: true });
  const carve = withIntentional.intentionally_never_wired as Array<{ service: string; id: string }>;
  assert.ok(carve.some((c) => c.service === 'posthog' && c.id === 'session_recordings'));
});
