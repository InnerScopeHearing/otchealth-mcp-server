import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type ToolDefinition } from './registry.js';

// Pins the 2026-07-26 M365 prefix-strip compat shim (registry.ts's registerTool): M365 Copilot's
// own tool-calling orchestrator has been observed splitting a registered tool name on its first
// underscore and calling only the remainder (confirmed precedent: memory/recall-alias.ts,
// 2026-07-25, "memory_recall" -> "recall"). Reproduced again for "github_repo_get" -> "repo_get"
// and "depot_run_list" -> "run_list" once the developer lane's M365 catalog was expanded to the
// full 70 github_* + 42 depot_* tools. This generates the SAME alias generically inside
// registerTool() itself (rather than 112 hand-written alias files) so every current AND future
// github_*/depot_* tool gets the compatibility name automatically, with an explicit, logged
// collision policy for the two real collisions in the current catalog (workflow_get/workflow_list,
// claimed by both a github_ and a depot_ tool).

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

/** Minimal fake McpServer: records every registered tool name, ignores config/handler wiring. */
function fakeServer(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as McpServer;
  return { server, names };
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

test('a github_* tool also registers under its stripped bare-suffix alias', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('github_repo_get'), () => 'caller-hash');
  assert.ok(names.includes('github_repo_get'), 'primary name must still be registered');
  assert.ok(names.includes('repo_get'), 'stripped alias must also be registered');
});

test('a depot_* tool also registers under its stripped bare-suffix alias', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('depot_run_list'), () => 'caller-hash');
  assert.ok(names.includes('depot_run_list'));
  assert.ok(names.includes('run_list'));
});

test('a non-github/depot tool never gets a stripped alias (e.g. brain_search stays exactly one name)', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('brain_search'), () => 'caller-hash');
  assert.deepEqual(names, ['brain_search']);
});

test('collision: github_workflow_get and depot_workflow_get both target "workflow_get" -- first wins, second keeps only its full name, neither call throws', () => {
  const { server, names } = fakeServer();
  assert.doesNotThrow(() => {
    registerTool(server, fakeDef('github_workflow_get'), () => 'caller-hash');
    registerTool(server, fakeDef('depot_workflow_get'), () => 'caller-hash');
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
  registerTool(server, fakeDef('github_workflow_list'), () => 'caller-hash');
  registerTool(server, fakeDef('depot_workflow_list'), () => 'caller-hash');
  const aliasCount = names.filter((n) => n === 'workflow_list').length;
  assert.equal(aliasCount, 1);
});

test('alias registration never recurses more than one level deep (isAlias guard)', () => {
  const { server, names } = fakeServer();
  registerTool(server, fakeDef('github_push_files'), () => 'caller-hash');
  // Exactly two registrations: the full name and its single stripped alias -- not three or more.
  assert.deepEqual(names.sort(), ['github_push_files', 'push_files'].sort());
});
