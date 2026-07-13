import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredRoleFor } from './governance.js';

// Regression guard for the connector-surface widen (2026-07-12): the DCR toolset now surfaces the
// git write tools. Every WRITE tool exposed there must be CTO-role-gated at execution time, or the
// widen becomes a real privilege grant to any write-enabled lane (cfo/clo/coo/cro/developer). The
// read tools (list/get workflow runs) intentionally carry no role gate. github_pr_update was the
// gap this test locks shut: it is category write_simple (no write_orchestrated default gate), so it
// needs an explicit governance rule.
const CONNECTOR_WRITE_TOOLS = [
  'github_create_branch',
  'github_create_or_update_file',
  'github_push_files',
  'github_create_pull_request',
  'github_pr_update',
];

const CONNECTOR_READ_TOOLS = ['github_list_workflow_runs', 'github_workflow_run_get'];

test('every git write tool on the connector surface is CTO-role-gated', () => {
  for (const name of CONNECTOR_WRITE_TOOLS) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must have a governance rule (else any write-enabled lane can execute it)`);
    assert.equal(gov?.role, 'cto', `${name} must be gated to the cto lane`);
  }
});

test('github_pr_update specifically is CTO-gated (write_simple has no orchestrated-default gate)', () => {
  assert.equal(requiredRoleFor('github_pr_update')?.role, 'cto');
});

test('workflow-run readers are intentionally ungated (reads are not an escalation)', () => {
  for (const name of CONNECTOR_READ_TOOLS) {
    assert.equal(requiredRoleFor(name), null, `${name} is a read; it should carry no role gate`);
  }
});
