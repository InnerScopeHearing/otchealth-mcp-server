import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('./cto-workspace-profile.mjs', import.meta.url);
test('CTO workspace bootstrap implementation exists', () => {
  assert.equal(existsSync(moduleUrl), true, 'missing CTO workspace bootstrap module');
});
if (existsSync(moduleUrl)) {
  const { ctoWorkspaceForRequest } = await import(moduleUrl.href);
  test('default diagnostic remains unchanged for every caller', () => {
    for (const lane of ['', 'external-read', 'cto', 'exec', 'developer', 'cfo', 'clo']) {
      assert.equal(ctoWorkspaceForRequest(false, lane, []), undefined);
    }
  });
  for (const lane of ['', 'external-read', 'exec', 'developer', 'cfo', 'clo', 'coo', 'cro', 'CTO', 'cto-admin']) {
    test(`bootstrap rejects non-CTO caller ${JSON.stringify(lane)}`, () => {
      assert.throws(() => ctoWorkspaceForRequest(true, lane, []), /forbidden_role/);
    });
  }
  test('CTO gets versioned operating instructions, not a privilege grant', () => {
    const p = ctoWorkspaceForRequest(true, 'cto', []);
    assert.equal(p.version, '1.0.0');
    assert.equal(p.authority.blanket_authorization_bypass, false);
    assert.equal(p.authority.other_agents_inherit_cto, false);
    assert.equal(p.authority.role, 'cto');
    assert.equal(p.activation.chatgpt_project_verified, false);
    assert.equal(p.activation.oauth_connection_verified, false);
    assert.match(p.project_instructions, /brain_search/);
    assert.match(p.project_instructions, /read back before retrying/i);
    assert.match(p.project_instructions, /production deployment/i);
    assert.match(p.project_instructions, /PHI/);
  });
  test('reports registry presence only, not permission or live execution', () => {
    const p = ctoWorkspaceForRequest(true, 'cto', ['wake', 'memory_remember', 'hyperagent_create_thread']);
    assert.equal(p.capabilities.registry_presence.wake, true);
    assert.equal(p.capabilities.registry_presence.brain_search, false);
    assert.equal(p.capabilities.registry_presence.memory_remember, true);
    assert.equal(p.capabilities.registry_presence.hyperagent_create_thread, true);
    assert.equal(p.capabilities.execution_verified, false);
    assert.equal(p.capabilities.all_sectors_admin_verified, false);
    assert.equal(p.capabilities.missing_core_tools.includes('brain_search'), true);
  });
  test('does not invent concurrent worker capacity or unlimited budget', () => {
    const p = ctoWorkspaceForRequest(true, 'cto', ['agent_dispatch', 'hyperagent_create_thread']);
    assert.equal(p.parallelism.policy, 'maximum-safe-runtime-supported');
    assert.equal(p.parallelism.max_concurrent_workers, null);
    assert.equal(p.parallelism.native_subagents_verified, false);
    assert.equal(p.parallelism.runtime_budget_verified, false);
    assert.equal(p.parallelism.synthetic_subagents_allowed, false);
    assert.match(p.parallelism.rule, /budget/);
  });
  test('hybrid memory excludes scratch work and preserves provenance', () => {
    const p = ctoWorkspaceForRequest(true, 'cto', []);
    assert.ok(p.memory.durable_categories.includes('architecture_decision'));
    assert.equal(p.memory.persist_scratch_reasoning, false);
    assert.equal(p.memory.require_provenance, true);
    assert.equal(p.memory.verify_ambiguous_writes, true);
  });
  test('returned profiles do not share mutable state across callers', () => {
    const first = ctoWorkspaceForRequest(true, 'cto', []);
    first.memory.durable_categories.push('unapproved');
    first.authority.other_agents_inherit_cto = true;
    const second = ctoWorkspaceForRequest(true, 'cto', []);
    assert.equal(second.memory.durable_categories.includes('unapproved'), false);
    assert.equal(second.authority.other_agents_inherit_cto, false);
  });
  test('only literal true requests a bootstrap; input errors fail closed', () => {
    assert.equal(ctoWorkspaceForRequest(undefined, 'cto', []), undefined);
    assert.throws(() => ctoWorkspaceForRequest('true', 'cto', []), /invalid/);
    assert.throws(() => ctoWorkspaceForRequest(true, 'cto', null), /invalid/);
  });
}
