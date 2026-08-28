import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, finalizeM365Aliases, type ToolDefinition, type CallerHashProvider } from './registry.js';
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
// TWO rounds of code review on that widening caught real bugs, all pinned below:
// Round 1: (a) the shim was unconditional, bloating EVERY caller's catalog (not just M365) -- now
//   gated behind isM365StaticAuth(); (b) an alias evaluated governance/curation/doctrine against its
//   own STRIPPED name instead of the canonical tool it stands in for -- fixed via
//   ToolDefinition.canonicalName.
// Round 2: (c) inboundShield's SELF_TOOLS exemption was also keyed off the stripped name (fixed in
//   registry.ts directly, not re-tested here -- see its own inline comment); (d) deleting
//   recall-alias.ts broke "recall" for every NON-M365 caller (it was unconditional; the generic
//   shim is M365-only) -- RESTORED, see below; (e) THE BIG ONE: "first tool through wins" doesn't
//   just leave the loser unreachable, it can SILENTLY MIS-ROUTE a real M365 call to the WRONG
//   tool's handler when 3+ tools collide on the same stripped name (e.g. n8n_workflow_get /
//   github_workflow_get / depot_workflow_get all -> "workflow_get"). Redesigned as a two-pass
//   collect-then-finalize: registerTool() only COLLECTS alias candidates now; finalizeM365Aliases()
//   must be called explicitly (once, after every tool has registered) to actually register the
//   unambiguous ones. Every test below reflects that -- register candidates, then finalize.

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
 * behavior can actually be exercised, not just presence/absence of a name).
 *
 * The returned RegisteredTool-shaped handle's `.remove()` genuinely detaches the registration
 * (2026-08-02 Copilot review on PR #185): this fake previously returned `void` from
 * `registerTool`, so `registry.ts`'s captured `primaryHandle` was always `undefined` and
 * `primaryHandle?.remove()` was a silent no-op -- meaning this entire suite exercised the
 * "register a candidate" half of the dedup fix but NEVER the "remove the now-redundant long-form
 * primary" half, the actual load-bearing behavior the fix ships. A real `.remove()` here is what
 * lets the tests below assert the long-form name is genuinely gone, matching the real MCP SDK's
 * `RegisteredTool.remove()` contract (server/mcp.d.ts). */
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
      return {
        remove: () => {
          const idx = names.indexOf(name);
          if (idx !== -1) names.splice(idx, 1);
          handlers.delete(name);
        },
      };
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

const hashProvider: CallerHashProvider = () => 'caller-hash';

/** Runs fn synchronously inside an M365 static-auth request context (candidate collection only
 * fires here). */
function withM365<T>(callerAgent: string, fn: () => T): T {
  return requestContext.run(
    { callerHash: 'test-hash', correlationId: 'test-corr', callerAgent, connectorSurface: false, m365StaticAuth: true },
    fn,
  );
}

test('a github_* tool also registers under its stripped bare-suffix alias, once finalized (inside an M365 request) -- and the now-redundant long-form primary is REMOVED (2026-08-02 dedup fix)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('github_repo_get'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(names.includes('repo_get'), 'stripped alias must be registered after finalization');
  assert.ok(!names.includes('github_repo_get'), 'the long-form primary must be REMOVED once its unambiguous alias is confirmed -- not left as a duplicate');
  assert.deepEqual(names, ['repo_get'], 'exactly one advertised name for this tool, not a long+short pair');
});

test('a depot_* tool also registers under its stripped bare-suffix alias, once finalized (inside an M365 request) -- and the now-redundant long-form primary is REMOVED (2026-08-02 dedup fix)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('depot_run_list'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(names.includes('run_list'));
  assert.ok(!names.includes('depot_run_list'), 'the long-form primary must be REMOVED once its unambiguous alias is confirmed');
  assert.deepEqual(names, ['run_list']);
});

test('an alias does NOT exist before finalizeM365Aliases() is called -- collection alone is not enough', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => registerTool(server, fakeDef('github_repo_get'), hashProvider));
  assert.deepEqual(names, ['github_repo_get'], 'no alias should exist until finalizeM365Aliases() runs');
});

// The two REAL production failures this widening fixes (Matt's 2026-07-28 Developer-agent
// diagnostic run against live M365 Copilot).
test('catalog_probe also registers under its stripped alias "probe" (the exact call Copilot made in production) -- long-form primary REMOVED (2026-08-02 dedup fix)', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => {
    registerTool(server, fakeDef('catalog_probe'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(names.includes('probe'));
  assert.ok(!names.includes('catalog_probe'), 'the long-form primary must be REMOVED once its unambiguous alias is confirmed');
  assert.deepEqual(names, ['probe']);
});

test('developer_wake_lite also registers under its stripped alias "wake_lite" (the exact call Copilot made in production) -- long-form primary REMOVED (2026-08-02 dedup fix)', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => {
    registerTool(server, fakeDef('developer_wake_lite'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(names.includes('wake_lite'));
  assert.ok(!names.includes('developer_wake_lite'), 'the long-form primary must be REMOVED once its unambiguous alias is confirmed');
  assert.deepEqual(names, ['wake_lite']);
});

test('a tool with no underscore at all (e.g. "wake" or "checkpoint") never gets a stripped alias -- nothing to strip', () => {
  const { server, names } = fakeServer();
  withM365('developer', () => {
    registerTool(server, fakeDef('wake'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.deepEqual(names, ['wake']);
});

// SCOPE FIX: outside an M365 static-auth request, no candidate is even collected, so finalizing is
// a no-op regardless -- this is what keeps Claude Code / Hyperagent / connector-client catalogs
// lean instead of silently doubling in size for callers that never needed M365 compatibility.
test('SCOPE: no alias is generated at all for a non-M365 caller (e.g. a normal Claude Code / OAuth request)', () => {
  const { server, names } = fakeServer();
  requestContext.run(
    { callerHash: 'h', correlationId: 'c', callerAgent: 'cto', connectorSurface: false, m365StaticAuth: false },
    () => {
      registerTool(server, fakeDef('github_repo_get'), hashProvider);
      finalizeM365Aliases(server, hashProvider);
    },
  );
  assert.deepEqual(names, ['github_repo_get'], 'no "repo_get" alias should be generated outside an M365 request');
});

test('SCOPE: no alias is generated at all with no request context (e.g. the catalog-warm startup call)', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('github_repo_get'), hashProvider);
  finalizeM365Aliases(server, hashProvider);
  assert.deepEqual(names, ['github_repo_get']);
});

// GOVERNANCE FIX (round 1, the security one): an alias must enforce the SAME role restriction as
// the canonical tool it stands in for. build_* is a real governance rule (CTO-only, see
// catalog/governance.ts) -- this exercises the ACTUAL handler, not just presence of the name.
// (This test originally used azure_containerapp_get / azure_* as its example; swapped 2026-08-28
// when the 13 azure_* tools and their governance rule were deleted outright -- build_* is CTO-only
// via the identical single-string 'cto' requiredRole shape, so it proves the same regression class.)
test('SECURITY: an alias of a role-gated tool still enforces the canonical tool\'s role restriction (regression for the governance-bypass finding)', async () => {
  const { server, handlers } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('build_dispatch_trigger'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  const aliasHandler = handlers.get('dispatch_trigger');
  assert.ok(aliasHandler, 'the "dispatch_trigger" alias must have registered (unambiguous -- only one candidate)');

  // A NON-cto lane calling the alias must be rejected exactly like it would be calling
  // "build_dispatch_trigger" directly -- not silently allowed through under the stripped name.
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
// required tool-name convention) -- not aliases of anything. finalizeM365Aliases() excludes any
// candidate name a REAL primary tool already owns, regardless of registration order.
test('reserved names: brain_search and kb_search do NOT generate a "search" alias (that name is a real standalone tool elsewhere), and nothing throws', () => {
  const { server, names } = fakeServer();
  assert.doesNotThrow(() => {
    withM365('cto', () => {
      registerTool(server, fakeDef('brain_search'), hashProvider);
      registerTool(server, fakeDef('kb_search'), hashProvider);
      registerTool(server, fakeDef('search'), hashProvider); // the REAL standalone tool
      finalizeM365Aliases(server, hashProvider);
    });
  });
  assert.ok(names.includes('brain_search'));
  assert.ok(names.includes('kb_search'));
  assert.equal(names.filter((n) => n === 'search').length, 1, '"search" must be registered exactly once -- the real tool, never an alias');
});

test('reserved names: a real tool literally named "search" is unaffected regardless of WHEN it registers relative to brain_search/kb_search', () => {
  for (const order of [
    ['search', 'brain_search', 'kb_search'],
    ['brain_search', 'search', 'kb_search'],
    ['brain_search', 'kb_search', 'search'],
  ]) {
    const { server, names } = fakeServer();
    withM365('cto', () => {
      for (const name of order) registerTool(server, fakeDef(name), hashProvider);
      finalizeM365Aliases(server, hashProvider);
    });
    assert.equal(names.filter((n) => n === 'search').length, 1, `order ${order.join(',')}: "search" must appear exactly once`);
  }
});

// THE BIG ONE (round 2): a 3-way collision must NOT silently pick a winner and mis-route a caller
// meant for one of the other two -- it must produce NO alias for any of them.
test('AMBIGUOUS 3-way collision (n8n_workflow_get / github_workflow_get / depot_workflow_get all -> "workflow_get"): NO alias is registered for any of them', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('n8n_workflow_get'), hashProvider);
    registerTool(server, fakeDef('github_workflow_get'), hashProvider);
    registerTool(server, fakeDef('depot_workflow_get'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(names.includes('n8n_workflow_get'));
  assert.ok(names.includes('github_workflow_get'));
  assert.ok(names.includes('depot_workflow_get'));
  assert.ok(!names.includes('workflow_get'), 'an ambiguous 3-way stripped name must get NO alias at all -- not a silent pick of whichever registered first');
});

test('a genuine 2-way collision (github_workflow_list / depot_workflow_list) also gets NO alias -- not "first wins"', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('github_workflow_list'), hashProvider);
    registerTool(server, fakeDef('depot_workflow_list'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  assert.ok(!names.includes('workflow_list'), 'a genuine collision must produce zero aliases, not a coin-flip winner');
});

test('order independence: the SAME 3-way collision produces NO alias no matter which tool registers first', () => {
  for (const order of [
    ['n8n_workflow_get', 'github_workflow_get', 'depot_workflow_get'],
    ['depot_workflow_get', 'n8n_workflow_get', 'github_workflow_get'],
    ['github_workflow_get', 'depot_workflow_get', 'n8n_workflow_get'],
  ]) {
    const { server, names } = fakeServer();
    withM365('cto', () => {
      for (const name of order) registerTool(server, fakeDef(name), hashProvider);
      finalizeM365Aliases(server, hashProvider);
    });
    assert.ok(!names.includes('workflow_get'), `order ${order.join(',')}: still must produce no alias`);
  }
});

test('alias registration never recurses more than one level deep (isAlias guard)', () => {
  const { server, names } = fakeServer();
  withM365('cto', () => {
    registerTool(server, fakeDef('github_push_files'), hashProvider);
    finalizeM365Aliases(server, hashProvider);
  });
  // Exactly ONE registration survives (2026-08-02 dedup fix removed the long-form primary): the
  // single stripped alias, not the alias PLUS a second-level alias of the alias, and not the
  // long+short pair either.
  assert.deepEqual(names, ['push_files']);
});

test('finalizeM365Aliases() is a safe no-op when called with no prior candidates', () => {
  const { server, names } = fakeServer();
  assert.doesNotThrow(() => finalizeM365Aliases(server, hashProvider));
  assert.deepEqual(names, []);
});

// Regression for round 2's "deleting recall-alias.ts broke recall for every non-M365 caller"
// finding: a tool deliberately registered under a bare name UNCONDITIONALLY (mirroring
// recall-alias.ts's "recall" alias for memory_recall) must (a) stay reachable for a normal,
// non-M365 caller, and (b) not get clobbered or duplicated by the generic M365 shim's own attempt
// to claim that same bare name from a differently-prefixed tool.
test('a tool registered unconditionally under a bare name (mirroring recall-alias.ts) survives outside an M365 request, and the generic shim does not collide with it inside one', () => {
  // (a) non-M365 caller: the unconditional registration alone must be enough.
  {
    const { server, names } = fakeServer();
    requestContext.run(
      { callerHash: 'h', correlationId: 'c', callerAgent: 'cto', connectorSurface: false, m365StaticAuth: false },
      () => {
        registerTool(server, fakeDef('recall'), hashProvider); // mirrors recall-alias.ts's unconditional call
        finalizeM365Aliases(server, hashProvider); // a no-op here, but must not throw or remove it
      },
    );
    assert.deepEqual(names, ['recall']);
  }
  // (b) M365 caller: memory_recall's own generic-shim candidate for "recall" must be excluded
  // because "recall" is already a real primary name, not silently overwritten or duplicated.
  {
    const { server, names } = fakeServer();
    withM365('developer', () => {
      registerTool(server, fakeDef('recall'), hashProvider); // the always-on registration, first
      registerTool(server, fakeDef('memory_recall'), hashProvider); // would also strip to "recall"
      assert.doesNotThrow(() => finalizeM365Aliases(server, hashProvider));
    });
    assert.equal(names.filter((n) => n === 'recall').length, 1, '"recall" must be registered exactly once, not duplicated');
    assert.ok(names.includes('memory_recall'));
  }
});
