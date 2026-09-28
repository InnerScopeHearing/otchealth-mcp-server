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

test('github_pr_mark_ready is CTO-only release control', () => {
  const gov = requiredRoleFor('github_pr_mark_ready');
  assert.equal(gov?.role, 'cto');
  assert.ok(!roleAllows(gov?.role ?? '', 'developer'));
});

test('github_make_broker is limited to CTO and the restricted Make pilot principal', () => {
  const gov = requiredRoleFor('github_make_broker');
  assert.ok(gov, 'the Make pilot broker must have an explicit governance rule');
  assert.ok(roleAllows(gov!.role, 'cto'));
  assert.ok(roleAllows(gov!.role, 'cto-make-github-pilot'));
  for (const other of ['developer', 'exec', 'coo', 'cfo', 'clo', 'cro', 'cco', 'cpo', 'clo-personal', 'external-read', '']) {
    assert.ok(!roleAllows(gov!.role, other), `the Make pilot broker must refuse lane "${other}"`);
  }
});

test('the Make pilot principal is denied direct GitHub writes and result fetching', () => {
  for (const name of [
    'github_create_branch', 'github_create_or_update_file', 'github_edit_file', 'github_push_files',
    'github_create_pull_request', 'github_pr_update', 'github_merge_pull_request', 'github_create_issue',
    'github_comment_on_issue', 'github_add_labels', 'github_create_release', 'github_dispatch_workflow',
    'gateway_fetch_result',
  ]) {
    const gov = requiredRoleFor(name);
    if (gov) assert.equal(roleAllows(gov.role, 'cto-make-github-pilot'), false, `${name} must deny the pilot role`);
  }
});

test('workflow-run readers are intentionally ungated (reads are not an escalation)', () => {
  for (const name of CONNECTOR_READ_TOOLS) {
    assert.equal(requiredRoleFor(name), null, `${name} is a read; it should carry no role gate`);
  }
});

test('pinned GraphRAG observation receipt reader is CTO-only', () => {
  const gov = requiredRoleFor('github_graphrag_observation_receipt_get');
  assert.ok(gov, 'the pinned receipt reader must have an explicit role gate');
  assert.ok(roleAllows(gov!.role, 'cto'));
  for (const other of [...OTHER_LANES, 'developer', 'exec']) {
    assert.ok(!roleAllows(gov!.role, other), `the pinned receipt reader must refuse lane "${other}"`);
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
  // 'azure_job_execute' was the original example here; replaced 2026-08-28 with 'release_cutover'
  // (the release_* prefix, "Release cutovers are CTO-only") when the 13 azure_* tools were deleted
  // outright and their GovRule removed -- requiredRoleFor is a pure pattern match against GOVERNANCE
  // (see its implementation), so this proves the SAME thing the azure_ example did.
  const stillCtoOnly = ['release_cutover', 'netlify_trigger_deploy', 'cloudflare_delete_dns_record', 'stripe_create_refund'];
  for (const name of stillCtoOnly) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must have a governance rule`);
    assert.ok(roleAllows(gov!.role, 'cto'), `${name} must allow cto`);
    assert.ok(!roleAllows(gov!.role, 'developer'), `${name} must NOT allow developer -- outside the GitHub/Depot directive scope`);
  }
});
