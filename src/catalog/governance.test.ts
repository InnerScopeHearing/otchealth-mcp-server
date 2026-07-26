import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredRoleFor, roleAllows } from './governance.js';

// Regression guard for the connector-surface widen (2026-07-12): the DCR toolset now surfaces the
// git write tools. Every WRITE tool exposed there must be role-gated at execution time, or the
// widen becomes a real privilege grant to any write-enabled lane (cfo/clo/coo/cro). The
// read tools (list/get workflow runs) intentionally carry no role gate. github_pr_update was the
// gap this test locks shut: it is category write_simple (no write_orchestrated default gate), so it
// needs an explicit governance rule.
//
// UPDATED 2026-07-26 (Matt/CEO directive): these tools are no longer cto-EXCLUSIVE -- the
// 'otchealth-dev' Copilot custom agent (caller_agent='developer') was deliberately widened to full
// GitHub read+write. This test now asserts the INTENT of that widen precisely via roleAllows():
// cto and developer must both pass, and every OTHER write-enabled lane (cfo/clo/coo/cro/etc.) must
// still be refused -- the widen was scoped to developer specifically, not opened to everyone.
const CONNECTOR_WRITE_TOOLS = [
  'github_create_branch',
  'github_create_or_update_file',
  'github_edit_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
];

const CONNECTOR_READ_TOOLS = ['github_list_workflow_runs', 'github_workflow_run_get'];

// A representative sample of OTHER write-enabled lanes that must NOT gain access from this widen.
const OTHER_LANES = ['cfo', 'clo', 'coo', 'cro', 'cpo', 'cco', ''];

test('every git write tool on the connector surface is role-gated to cto/developer only', () => {
  for (const name of CONNECTOR_WRITE_TOOLS) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must have a governance rule (else any write-enabled lane can execute it)`);
    assert.ok(roleAllows(gov!.role, 'cto'), `${name} must allow cto`);
    assert.ok(roleAllows(gov!.role, 'developer'), `${name} must allow developer (2026-07-26 widen)`);
    for (const other of OTHER_LANES) {
      assert.ok(!roleAllows(gov!.role, other), `${name} must NOT allow lane "${other}" -- the widen was scoped to developer only`);
    }
  }
});

test('github_pr_update specifically allows cto and developer only (write_simple has no orchestrated-default gate)', () => {
  const gov = requiredRoleFor('github_pr_update');
  assert.ok(roleAllows(gov?.role ?? '', 'cto'));
  assert.ok(roleAllows(gov?.role ?? '', 'developer'));
  assert.ok(!roleAllows(gov?.role ?? '', 'cfo'));
});

test('workflow-run readers are intentionally ungated (reads are not an escalation)', () => {
  for (const name of CONNECTOR_READ_TOOLS) {
    assert.equal(requiredRoleFor(name), null, `${name} is a read; it should carry no role gate`);
  }
});

test('depot_* is role-gated to cto/developer only (2026-07-26 widen -- full Depot read+write for developer)', () => {
  const gov = requiredRoleFor('depot_trigger_build');
  assert.ok(gov, 'depot_trigger_build must have a governance rule');
  assert.ok(roleAllows(gov!.role, 'cto'), 'depot_trigger_build must allow cto');
  assert.ok(roleAllows(gov!.role, 'developer'), 'depot_trigger_build must allow developer');
  for (const other of OTHER_LANES) {
    assert.ok(!roleAllows(gov!.role, other), `depot_trigger_build must NOT allow lane "${other}"`);
  }
});

test('infra/money tools outside the 2026-07-26 directive remain cto-exclusive', () => {
  const stillCtoOnly = ['azure_job_execute', 'netlify_trigger_deploy', 'cloudflare_delete_dns_record', 'stripe_create_refund'];
  for (const name of stillCtoOnly) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must have a governance rule`);
    assert.ok(roleAllows(gov!.role, 'cto'), `${name} must allow cto`);
    assert.ok(!roleAllows(gov!.role, 'developer'), `${name} must NOT allow developer -- outside the GitHub/Depot directive scope`);
  }
});
