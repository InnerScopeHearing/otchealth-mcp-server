import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Wave 6 item 6.2 (per-lane tool-catalog curation for internal client_credentials lanes).
//
// These tests exercise the REAL registration path (registerAllTools -> registry.ts's registerTool)
// against a fresh McpServer per case, reading the server's own `_registeredTools` map (the MCP SDK's
// internal registration table -- same shape catalog-warm.test.ts already relies on for its
// tool-count floor) so this proves what actually gets ADVERTISED, not just what the pure helpers
// compute in isolation.
//
// THE CENTRAL GUARANTEE UNDER TEST: TOOL_CATALOG_CURATION_MODE's default (unset, or 'report', or
// 'off') must NEVER narrow any lane's advertised toolset below the full catalog. Only an explicit
// TOOL_CATALOG_CURATION_MODE=curate may narrow a KNOWN internal lane, and even then an unscoped lane
// stays uncurated (fail-open).

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

afterEach(() => {
  delete process.env.TOOL_CATALOG_CURATION_MODE;
});

async function registeredToolCount(lane: string): Promise<number> {
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash, requestContext } = await import('../server/request-context.js');
  const mcp = new McpServer(
    { name: 'test', version: '0' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  await requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent: lane, connectorSurface: false },
    async () => {
      registerAllTools(mcp, currentCallerHash);
    },
  );
  // `_registeredTools` is the MCP SDK's own internal registration table (an object keyed by tool
  // name) -- reading it here proves what THIS server instance actually advertises, independent of
  // the shared module-level Capability Catalog singleton (which upserts by name across every
  // registerAllTools() call in the process and would not isolate one invocation's result).
  return Object.keys((mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).length;
}

test('DEFAULT (TOOL_CATALOG_CURATION_MODE unset) -- every known internal lane gets the FULL, uncurated catalog', async () => {
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  const lanes = ['cto', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'developer', 'exec'];
  const counts = await Promise.all(lanes.map((lane) => registeredToolCount(lane)));
  const unscopedCount = await registeredToolCount('some-unscoped-lane');
  for (const [i, lane] of lanes.entries()) {
    assert.equal(
      counts[i],
      unscopedCount,
      `lane ${lane} should register the SAME tool count as an unscoped lane by default (got ${counts[i]} vs ${unscopedCount})`,
    );
    assert.ok(counts[i] >= 800, `lane ${lane} should see >= 800 tools by default, got ${counts[i]}`);
  }
});

test("explicit TOOL_CATALOG_CURATION_MODE=report -- identical to the default (never restricts)", async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'report';
  const reportCount = await registeredToolCount('developer');
  delete process.env.TOOL_CATALOG_CURATION_MODE;
  const defaultCount = await registeredToolCount('developer');
  assert.equal(reportCount, defaultCount);
  assert.ok(reportCount >= 800);
});

test("explicit TOOL_CATALOG_CURATION_MODE=off -- also never restricts", async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'off';
  const offCount = await registeredToolCount('cfo');
  assert.ok(offCount >= 800);
});

test('TOOL_CATALOG_CURATION_MODE=curate -- narrows a KNOWN internal lane below the full catalog', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  const fullCount = await registeredToolCount('some-unscoped-lane'); // unscoped: fail-open, stays full
  const developerCount = await registeredToolCount('developer');
  assert.ok(fullCount >= 800, `unscoped lane should stay at the full catalog even in curate mode, got ${fullCount}`);
  assert.ok(
    developerCount < fullCount,
    `curate mode should narrow the 'developer' lane below the full catalog (got ${developerCount} vs ${fullCount})`,
  );
  assert.ok(developerCount > 0, 'developer lane should still see a non-empty toolset');
});

test('TOOL_CATALOG_CURATION_MODE=curate -- an unscoped/unknown lane is NEVER curated (fail-open)', async () => {
  process.env.TOOL_CATALOG_CURATION_MODE = 'curate';
  const unscopedCount = await registeredToolCount('some-random-app-lead-agent');
  const defaultLikeCount = await registeredToolCount('another-unscoped-lane');
  assert.equal(unscopedCount, defaultLikeCount);
  assert.ok(unscopedCount >= 800);
});
