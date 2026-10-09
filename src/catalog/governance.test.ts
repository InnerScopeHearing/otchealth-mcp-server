import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredRoleFor, roleAllows } from './governance.js';
import {
  COMPANY_GITHUB_OPERATOR_LANES,
  GITHUB_OPERATOR_TOOLSET,
  GITHUB_OPERATOR_WRITE_TOOLS,
} from '../config/github-operator.js';

const GITHUB_OPERATOR_READ_TOOLS = GITHUB_OPERATOR_TOOLSET.filter(
  (tool) => !(GITHUB_OPERATOR_WRITE_TOOLS as readonly string[]).includes(tool),
);
const NON_OPERATOR_LANES = ['', 'external-read', 'unknown', 'cto-make-github-pilot', 'make-github-pilot'];

test('every bounded GitHub operator tool is governed by the canonical company lane list', () => {
  for (const name of GITHUB_OPERATOR_TOOLSET) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must have an execution governance rule`);
    assert.deepEqual(gov!.role, COMPANY_GITHUB_OPERATOR_LANES, `${name} must reuse the canonical lane list`);
    for (const lane of COMPANY_GITHUB_OPERATOR_LANES) {
      assert.equal(roleAllows(gov!.role, lane), true, `${name} must allow ${lane}`);
    }
    for (const lane of NON_OPERATOR_LANES) {
      assert.equal(roleAllows(gov!.role, lane), false, `${name} must refuse ${lane || '(empty)'}`);
    }
  }
});

test('bounded GitHub reads carry the same defense-in-depth execution gate as writes', () => {
  for (const name of GITHUB_OPERATOR_READ_TOOLS) {
    const gov = requiredRoleFor(name);
    assert.deepEqual(gov?.role, COMPANY_GITHUB_OPERATOR_LANES, `${name} must deny non-operator identities even if exposed accidentally`);
  }
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

test('adjacent release and label administration is not widened with the bounded operator surface', () => {
  for (const name of ['github_add_labels', 'github_create_release']) {
    const gov = requiredRoleFor(name);
    assert.ok(gov, `${name} must retain its prior explicit rule`);
    assert.equal(roleAllows(gov!.role, 'cto'), true);
    assert.equal(roleAllows(gov!.role, 'developer'), true);
    for (const lane of COMPANY_GITHUB_OPERATOR_LANES) {
      if (lane === 'cto' || lane === 'developer') continue;
      assert.equal(roleAllows(gov!.role, lane), false, `${name} must not be widened to ${lane}`);
    }
  }
});

test('pinned GraphRAG observation receipt reader is CTO-only', () => {
  const gov = requiredRoleFor('github_graphrag_observation_receipt_get');
  assert.ok(gov, 'the pinned receipt reader must have an explicit role gate');
  assert.ok(roleAllows(gov!.role, 'cto'));
  for (const other of [...COMPANY_GITHUB_OPERATOR_LANES.filter((lane) => lane !== 'cto'), ...NON_OPERATOR_LANES]) {
    assert.ok(!roleAllows(gov!.role, other), `the pinned receipt reader must refuse lane "${other}"`);
  }
});

test('depot_* is role-gated to cto/developer only (2026-07-26 widen -- full Depot read+write for developer)', () => {
  const gov = requiredRoleFor('depot_trigger_build');
  assert.ok(gov, 'depot_trigger_build must have a governance rule');
  assert.ok(roleAllows(gov!.role, 'cto'), 'depot_trigger_build must allow cto');
  assert.ok(roleAllows(gov!.role, 'developer'), 'depot_trigger_build must allow developer');
  for (const other of [...COMPANY_GITHUB_OPERATOR_LANES.filter((lane) => lane !== 'cto' && lane !== 'developer'), ...NON_OPERATOR_LANES]) {
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

test('failed-step CI log excerpt reader is CTO-only', () => {
  const gov = requiredRoleFor('github_workflow_run_failed_log_excerpt');
  assert.ok(gov, 'the CI log excerpt reader must have an explicit role gate');
  assert.ok(roleAllows(gov!.role, 'cto'));
  for (const other of [...COMPANY_GITHUB_OPERATOR_LANES.filter((lane) => lane !== 'cto'), ...NON_OPERATOR_LANES]) {
    assert.ok(!roleAllows(gov!.role, other), `the CI log excerpt reader must refuse lane "${other}"`);
  }
});
