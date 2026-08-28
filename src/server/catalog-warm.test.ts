import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Regression guard for the 2026-07-01 deploy failure: tools register lazily per MCP request, so
// before the first session the capability catalog is empty and toolCount() (exposed on /health)
// reads 0, which trips the deploy pipeline's tool_count regression guard on a perfectly good image.
// registerMcpRoutes now warms the catalog at startup; this proves registerAllTools populates it to
// the full tool surface (>= the pipeline's MIN_TOOLS floor, 990 as of 2026-08-28 -- was 1003 before
// the 13 azure_* tools were deleted outright; see deploy.yml's MIN_TOOLS and this PR's other
// azure-removal touch points). This is a FLOOR, not the exact live count -- the live catalog can
// (and does) sit above it as new tools are added; a deploy-time check should assert the exact
// pre-deploy-measured count minus any tools this specific deploy removes, not this test's floor.
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

test('registerAllTools warms the capability catalog to the full tool surface (deploy gate guard)', async () => {
  const { toolCount } = await import('../catalog/catalog.js');
  const { registerAllTools } = await import('../tools/index.js');
  const { currentCallerHash } = await import('./request-context.js');

  assert.equal(toolCount(), 0, 'the catalog should start empty (tools register lazily)');

  registerAllTools(
    new McpServer(
      { name: 'test', version: '0' },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    ),
    currentCallerHash,
  );

  const n = toolCount();
  assert.ok(n >= 990, `expected the warmed catalog to expose >= 990 tools (the deploy MIN_TOOLS floor), got ${n}`);
});
