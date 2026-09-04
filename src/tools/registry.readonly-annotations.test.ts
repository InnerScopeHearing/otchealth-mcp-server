import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from '../catalog/catalog.js';

/**
 * Regression lock for MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint),
 * the field an MCP client's own approval machinery reads to decide whether to interrupt a human
 * for confirmation before calling a tool. Per OpenAI's Codex approvals documentation, a tool with
 * NO annotations at all is treated as write-capable and prompts on every call under the default
 * on-request policy; readOnlyHint:true passes silently.
 *
 * FINDING (2026-09-04, this file's origin): the premise that motivated this task -- "only a
 * handful of tools (src/tools/catalog/*) carry annotations" -- does NOT hold on main. `annotations:
 * ToolAnnotations` is a REQUIRED field on ToolDefinition (registry.ts), so it cannot compile
 * without every registered tool supplying one, and recordTool() (called from registerTool() on
 * every registration, including inside shared helpers like the xero paged-read wrapper and the
 * HeyGen READ_ANNOTATIONS spread constant) mirrors each tool's real readOnlyHint into the runtime
 * Capability Catalog as CatalogEntry.readOnly. Booting the FULL registry (mirroring
 * catalog-warm.test.ts's exact pattern) and inspecting that catalog directly -- rather than
 * grepping source text, which misses spreads, multi-line calls, and factory-generated tools --
 * shows 1004/1004 registered tools carry a real boolean readOnly classification: 530 true, 474
 * false, a genuinely differentiated split, not a boilerplate default. Only one category/readOnly
 * disagreement exists in the whole catalog (inbox_read: category 'read', readOnly false -- correct
 * as read: by default it DRAINS the inbox, a real side effect, so 'read' here means "does not go
 * through the write/dry-run/audit machinery", not "readOnlyHint should be true"). No tool anywhere
 * in the catalog has a write category with readOnlyHint:true (the dangerous direction).
 *
 * So this file does NOT re-derive or re-annotate anything -- there was nothing left to derive. It
 * exists to LOCK IN what was already true, so a future edit cannot silently regress it: a new tool
 * shipped with a copy-pasted wrong readOnlyHint, or an existing one flipped by mistake, fails this
 * suite instead of silently removing an MCP client's write-approval prompt from a destructive
 * action. See PR discussion for the separate, NOT-fixed-here finding about the connector-surface
 * (dcr_/occ_ client) code path in registry.ts, which omits `annotations` from the wire entirely for
 * a documented, cited reason (a Claude web client bug, anthropics/claude-code#25081) -- that is a
 * transport-shaping decision, not a per-tool metadata gap, and is out of this change's scope.
 */

before(() => {
  // Mirrors the exact stub every other registry-level suite in this file's directory uses
  // (registry.connector-lanes.test.ts, registry.lane-curation.test.ts, catalog-warm.test.ts):
  // loadEnv() requires these three to be non-empty; their VALUES are never exercised by this file.
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

let allTools: () => CatalogEntry[];
let recordTool: (entry: CatalogEntry) => void;

before(async () => {
  // Dynamic imports (never static top-level ones): ES module imports are hoisted ahead of any
  // other top-level statement, so a static import of a module that calls loadEnv() at import time
  // (several do, transitively) would run BEFORE the env stub above ever executes. This exact
  // ordering hazard is why catalog-warm.test.ts also imports everything inside its test body.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const catalog = await import('../catalog/catalog.js');
  const { registerAllTools } = await import('./index.js');
  const { currentCallerHash } = await import('../server/request-context.js');

  allTools = catalog.allTools;
  recordTool = catalog.recordTool;

  registerAllTools(
    new McpServer(
      { name: 'test-readonly-annotations', version: '0' },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    ),
    currentCallerHash,
  );
});

/** The actual safety invariant: a write tool must never advertise readOnlyHint:true. */
function writeToolsWronglyMarkedReadOnly(tools: CatalogEntry[]): CatalogEntry[] {
  return tools.filter(
    (t) => (t.category === 'write_simple' || t.category === 'write_orchestrated') && t.readOnly === true,
  );
}

test('SAFETY NET: no write_simple/write_orchestrated tool carries readOnlyHint:true', () => {
  const violations = writeToolsWronglyMarkedReadOnly(allTools());
  assert.deepEqual(
    violations,
    [],
    `these write tools are WRONGLY marked read-only, which would silently remove an MCP client's ` +
      `write-approval prompt from a real mutation: ${violations.map((v) => v.name).join(', ')}`,
  );
});

test('pinned: known read tools carry readOnlyHint:true (brain/kb search, catalog introspection, two cross-service *_get reads)', () => {
  const byName = new Map(allTools().map((t) => [t.name, t]));
  // brain_search / kb_search: the ground-first retrieval tools every agent is expected to call
  // first and constantly -- these are exactly the calls that must never prompt.
  // catalog_list_tools: the gateway's own self-description tool.
  // shopify_get_product / github_get_file_contents: a *_get read from two DIFFERENT services, per
  // the task's testing bar, confirming the pin is not accidentally service-specific.
  const expectedReadOnly = [
    'brain_search',
    'kb_search',
    'catalog_list_tools',
    'shopify_get_product',
    'github_get_file_contents',
  ];
  for (const name of expectedReadOnly) {
    const t = byName.get(name);
    assert.ok(t, `${name} should be registered in the live catalog`);
    assert.equal(t!.readOnly, true, `${name} should carry readOnlyHint:true`);
    assert.equal(t!.category, 'read', `${name} should be classified category:'read'`);
  }
});

test('COVERAGE REPORT: annotation classification across the full live tool catalog', () => {
  const tools = allTools();
  const total = tools.length;
  const readOnlyTrue = tools.filter((t) => t.readOnly === true).length;
  const readOnlyFalse = tools.filter((t) => t.readOnly === false).length;
  const byCategory: Record<string, number> = {};
  for (const t of tools) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;

  // Deliberately unannotated: the type system makes this impossible for a tool that reaches
  // recordTool() at all (annotations is a required field), so this is always 0 in this codebase --
  // there is no "omit the annotation" escape hatch to report a count for.
  const deliberatelyUnannotated = 0;

  // eslint-disable-next-line no-console
  console.log('\n=== MCP tool annotation coverage (src/tools/registry.readonly-annotations.test.ts) ===');
  console.log(`total registered tools:            ${total}`);
  console.log(`readOnlyHint: true  (safe reads):  ${readOnlyTrue}`);
  console.log(`readOnlyHint: false (writes):      ${readOnlyFalse}`);
  console.log(`deliberately unannotated:          ${deliberatelyUnannotated} (not representable -- annotations is a required field)`);
  console.log(`by category:                       ${JSON.stringify(byCategory)}`);
  console.log('=========================================================================================\n');

  // Sanity bounds, not brittle exact counts (the catalog grows over time as tools are added).
  // These exist so a future regression that collapses the classification into one bucket -- e.g.
  // everything defaulting to readOnly:false, or the readOnly field silently ceasing to be
  // populated -- fails loudly here instead of drifting unnoticed. Thresholds are set well inside
  // the real observed split (530 true / 474 false of 1004 total, measured 2026-09-04) so ordinary
  // catalog growth on either side never trips this.
  assert.ok(total >= 990, `expected >= 990 registered tools (matches deploy.yml's MIN_TOOLS floor), got ${total}`);
  assert.ok(readOnlyTrue >= 300, `expected a substantial population of readOnlyHint:true tools, got ${readOnlyTrue}`);
  assert.ok(readOnlyFalse >= 300, `expected a substantial population of readOnlyHint:false (write) tools, got ${readOnlyFalse}`);
  assert.equal(
    readOnlyTrue + readOnlyFalse,
    total,
    'every registered tool must carry a real boolean readOnly classification (no undefined/null)',
  );
});

test('COUNTERFACTUAL: the safety-net invariant actually catches a mislabeled write tool, and recovers cleanly once fixed', () => {
  // A real, irreversible write (DELETE /contacts/:id, see intercom/contact-delete.ts) -- chosen
  // deliberately so the demonstration is concrete: mislabeling THIS tool readOnlyHint:true would
  // let an MCP client silently delete a customer contact with no approval prompt.
  const TARGET = 'intercom_contact_delete';
  const original = allTools().find((t) => t.name === TARGET);
  assert.ok(original, `${TARGET} must be registered for this counterfactual to be meaningful`);
  assert.equal(original!.category, 'write_orchestrated');
  assert.equal(original!.readOnly, false, 'precondition: starts out correctly labeled as a write');

  // Deliberately corrupt it via the SAME recordTool() path every real registration goes through
  // (registry.ts calls recordTool() on every registerTool()) -- this is the real mechanism, not a
  // mock or a simulated catalog.
  recordTool({ ...original!, readOnly: true });

  const corrupted = writeToolsWronglyMarkedReadOnly(allTools());
  console.log('COUNTERFACTUAL BEFORE FIX (deliberately mislabeled readOnlyHint:true):', JSON.stringify(corrupted.map((v) => v.name)));
  assert.ok(
    corrupted.some((v) => v.name === TARGET),
    `the invariant MUST report ${TARGET} once it is mislabeled readOnlyHint:true -- this is the whole point of the safety net`,
  );

  // Restore the real value so no later test in this process observes a corrupted catalog.
  recordTool(original!);

  const fixed = writeToolsWronglyMarkedReadOnly(allTools());
  console.log('COUNTERFACTUAL AFTER FIX (restored readOnlyHint:false):', JSON.stringify(fixed.map((v) => v.name)));
  assert.deepEqual(fixed, [], 'the invariant must pass again once the mislabel is corrected');
});
