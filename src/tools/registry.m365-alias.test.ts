import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type ToolDefinition } from './registry.js';
import { requestContext } from '../server/request-context.js';

// Pins the 2026-07-26 M365 prefix-strip compat shim (registry.ts's registerTool), WIDENED +
// HARDENED 2026-07-28: M365 Copilot's own tool-calling orchestrator has been observed splitting a
// registered tool name on its first underscore and calling only the remainder (confirmed
// precedent: memory/recall-alias.ts, 2026-07-25, "memory_recall" -> "recall"; then
// "github_repo_get" -> "repo_get" and "depot_run_list" -> "run_list", 2026-07-26). The shim was
// originally scoped to just github_/depot_. WIDENED after a live production Developer-agent
// diagnostic (Matt, 2026-07-28) hit the identical failure on "catalog_probe" -> "probe" and
// "developer_wake_lite" -> "wake_lite" -- proving the behavior is generic to any underscored name.
//
// A code review of that widening caught two real bugs, both pinned below: (1) the shim was
// unconditional, bloating EVERY caller's catalog (not just M365) -- now gated behind
// isM365StaticAuth(), so every test here runs inside a requestContext with m365StaticAuth: true;
// (2) an alias evaluated governance/curation/doctrine against its own STRIPPED name instead of the
// canonical tool it stands in for -- e.g. "containerapp_get" (alias of the CTO-only
// azure_containerapp_get) didn't match the governance `azure_*` pattern, so any authenticated lane
// could call it unrestricted. Fixed via ToolDefinition.canonicalName.

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

/** Minimal fake McpServer: records every registered tool name AND its handler (so governance
 * behavior can actually be exercised, not just presence/absence of a name). */
function fakeServer(): {
  server: McpServer;
  names: string[];
  handlers: Map<string, (args: unknown) => Promise<{ content?: Array<{ text?: string }> }>>;
} {
  const names: string[] = [];
  const handlers = new Map<string, (args: unknown) => Promise<{ content?: Array<{ text?: string }> }>>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: (args: unknown) => Promise<{ content?: Array<{ text?: string }> }>) => {
      names.push(name);
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, names, handlers };
}

function fakeDef(name: string): ToolDefinition<Record<string, never>, Record<string, never>> {
  return {
    name,
    category: 'read',
    annotations: {
      title: name,
      description: name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: {},
    handler: async () => ({ data: null }),
  };
}

/** Runs fn synchronously inside an M365 static-auth request context (the shim only fires here). */
function withM365<T>(callerAgent: string, fn: () => T): T {
  return requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent, connectorSurface: false, m365StaticAuth: true },
    fn,
  );
}

test('a github_* tool also registers under its stripped bare-suffix alias (inside an M365 request)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => registerTool(server, fakeDef('github_repo_get'), () => 'caller-hash'));
  assert.ok(names.includes('github_repo_get'), 'primary name must still be registered');
  assert.ok(names.includes('repo_get'), 'stripped alias must also be registered');
});

test('a depot_* tool also registers under its stripped bare-suffix alias (inside an M365 request)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => registerTool(server, fakeDef('depot_run_list'), () => 'caller-hash'));
  assert.ok(names.includes('depot_run_list'));
  assert.ok(names.includes('run_list'));
});

// The two REAL production failures this widening fixes (Matt's 2026-07-28 Developer-agent
// diagnostic run against live M365 Copilot).
test('catalog_probe also registers under its stripped alias "probe" (the exact call Copilot made in production)', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => registerTool(server, fakeDef('catalog_probe'), () => 'caller-hash'));
  assert.ok(names.includes('catalog_probe'));
  assert.ok(names.includes('probe'));
});

test('developer_wake_lite also registers under its stripped alias "wake_lite" (the exact call Copilot made in production)', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => registerTool(server, fakeDef('developer_wake_lite'), () => 'caller-hash'));
  assert.ok(names.includes('developer_wake_lite'));
  assert.ok(names.includes('wake_lite'));
});

test('a tool with no underscore at all (e.g. "wake" or "checkpoint") never gets a stripped alias -- nothing to strip', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => registerTool(server, fakeDef('wake'), () => 'caller-hash'));
  assert.deepEqual(names, ['wake']);
});

// SCOPE FIX (review finding #1): outside an M365 static-auth request, the shim must not fire at
// all -- this is what keeps Claude Code / Hyperagent / connector-client catalogs lean instead of
// silently doubling in size for callers that never needed M365 compatibility.
test('SCOPE: no alias is generated at all for a non-M365 caller (e.g. a normal Claude Code / OAuth request)', () => {
  const { server, names } = fakeServer();
  requestContext.run(
    { callerHash: 'h', correlationId: 'c', callerAgent: 'cto', connectorSurface: false, m365StaticAuth: false },
    () => registerTool(server, fakeDef('github_repo_get'), () => 'caller-hash'),
  );
  assert.deepEqual(names, ['github_repo_get'], 'no "repo_get" alias should be generated outside an M365 request');
});

test('SCOPE: no alias is generated at all with no request context (e.g. the catalog-warm startup call)', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('github_repo_get'), () => 'caller-hash');
  assert.deepEqual(names, ['github_repo_get']);
});

// GOVERNANCE FIX (review finding #2, the security one): an alias must enforce the SAME role
// restriction as the canonical tool it stands in for. azure_* is a real governance rule (CTO-only,
// see catalog/governance.ts) -- this exercises the ACTUAL handler, not just presence of the name.
test('SECURITY: an alias of a role-gated tool still enforces the canonical tool\'s role restriction (regression for the 2026-07-28 governance-bypass finding)', async () => {
  const { server, handlers } = fakeServer();
  withM365('cto', () => registerTool(server, fakeDef('azure_containerapp_get'), () => 'caller-hash'));
  const aliasHandler = handlers.get('containerapp_get');
  assert.ok(aliasHandler, 'the "containerapp_get" alias must have registered');

  // A NON-cto lane calling the alias must be rejected exactly like it would be calling
  // "azure_containerapp_get" directly -- not silently allowed through under the stripped name.
  const rejected = await withM365('clo', () => aliasHandler!({}));
  const rejectedText = rejected.content?.[0]?.text ?? '';
  assert.ok(
    /restricted to the cto agent/i.test(rejectedText),
    `expected a role-restriction rejection for a non-cto caller, got: ${JSON.stringify(rejected)}`,
  );

  // The cto lane itself must still be allowed through (the fix must not over-block).
  const allowed = await withM365('cto', () => aliasHandler!({}));
  const allowedText = allowed.content?.[0]?.text ?? '';
  assert.ok(
    !/restricted to the cto agent/i.test(allowedText),
    `expected the cto lane to be allowed through the alias, got: ${JSON.stringify(allowed)}`,
  );
});

// Found while widening this shim: "search" and "fetch" are REAL, standalone tools registered under
// exactly those bare names elsewhere (openai-search.ts / openai-fetch.ts, the ChatGPT connector's
// required tool-name convention) -- not aliases of anything. If brain_search/kb_search were allowed
// to auto-claim "search" as their stripped alias, whichever one registered first would silently
// steal that name, and the REAL "search" tool's own later registration would hit the MCP SDK's hard
// "already registered" throw (reproduced directly during this fix -- it took down the whole
// catalog). RESERVED_BARE_TOOL_NAMES excludes them unconditionally, regardless of order.
test('reserved bare names: brain_search and kb_search do NOT generate a "search" alias (that name is a real standalone tool elsewhere), and neither call throws', () => {
  const { server, names } = fakeServer();
  assert.doesNotThrow(() => {
    withM365('cto', () => {
      registerTool(server, fakeDef('brain_search'), () => 'caller-hash');
      registerTool(server, fakeDef('kb_search'), () => 'caller-hash');
    });
  });
  assert.ok(names.includes('brain_search'));
  assert.ok(names.includes('kb_search'));
  assert.ok(!names.includes('search'), '"search" must never be auto-claimed as an alias');
});

test('reserved bare names: a real tool literally named "search" can register cleanly even AFTER brain_search/kb_search already ran', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('brain_search'), () => 'caller-hash');
    registerTool(server, fakeDef('kb_search'), () => 'caller-hash');
  });
  assert.doesNotThrow(() => {
    withM365('cto', () => registerTool(server, fakeDef('search'), () => 'caller-hash'));
  });
  assert.equal(names.filter((n) => n === 'search').length, 1);
});

test('collision: github_workflow_get and depot_workflow_get both target "workflow_get" -- first wins, second keeps only its full name, neither call throws', () => {
  const { server, names } = fakeServer();
  assert.doesNotThrow(() => {
    withM365('cto', () => {
      registerTool(server, fakeDef('github_workflow_get'), () => 'caller-hash');
      registerTool(server, fakeDef('depot_workflow_get'), () => 'caller-hash');
    });
  });
  assert.ok(names.includes('github_workflow_get'));
  assert.ok(names.includes('depot_workflow_get'));
  // Exactly one alias "workflow_get" should have been registered (the first tool through wins);
  // the second registration must NOT re-register/duplicate it.
  const aliasCount = names.filter((n) => n === 'workflow_get').length;
  assert.equal(aliasCount, 1, 'the bare alias must be claimed exactly once, not duplicated or dropped');
});

test('collision: github_workflow_list and depot_workflow_list both target "workflow_list" -- same safe behavior', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('github_workflow_list'), () => 'caller-hash');
    registerTool(server, fakeDef('depot_workflow_list'), () => 'caller-hash');
  });
  const aliasCount = names.filter((n) => n === 'workflow_list').length;
  assert.equal(aliasCount, 1);
});

test('alias registration never recurses more than one level deep (isAlias guard)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => registerTool(server, fakeDef('github_push_files'), () => 'caller-hash'));
  // Exactly two registrations: the full name and its single stripped alias -- not three or more.
  assert.deepEqual(names.sort(), ['github_push_files', 'push_files'].sort());
});
