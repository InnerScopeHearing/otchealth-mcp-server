import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_GITHUB_OPERATOR_LANES,
  GITHUB_OPERATOR_TOOLSET,
  GITHUB_OPERATOR_WRITE_TOOLS,
  isCompanyGitHubOperatorLane,
} from './github-operator.js';

test('company GitHub operator lanes are exact, unique, and exclude external/pilot identities', () => {
  assert.deepEqual(COMPANY_GITHUB_OPERATOR_LANES, [
    'cto', 'developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec',
    'wefunder-campaign-director',
  ]);
  assert.equal(new Set(COMPANY_GITHUB_OPERATOR_LANES).size, COMPANY_GITHUB_OPERATOR_LANES.length);
  for (const lane of COMPANY_GITHUB_OPERATOR_LANES) assert.equal(isCompanyGitHubOperatorLane(lane), true, lane);
  for (const lane of ['', 'unknown', 'external-read', 'cto-make-github-pilot', 'make-github-pilot']) {
    assert.equal(isCompanyGitHubOperatorLane(lane), false, lane || '(empty)');
  }
});

test('bounded GitHub operator toolset is unique and its write subset is complete', () => {
  assert.equal(GITHUB_OPERATOR_TOOLSET.length, 29);
  assert.equal(new Set(GITHUB_OPERATOR_TOOLSET).size, GITHUB_OPERATOR_TOOLSET.length);
  assert.equal(GITHUB_OPERATOR_WRITE_TOOLS.length, 15);
  assert.equal(new Set(GITHUB_OPERATOR_WRITE_TOOLS).size, GITHUB_OPERATOR_WRITE_TOOLS.length);
  for (const tool of GITHUB_OPERATOR_WRITE_TOOLS) {
    assert.equal(GITHUB_OPERATOR_TOOLSET.includes(tool), true, `${tool} must be in the operator toolset`);
  }
});

test('bounded operator toolset excludes secrets, settings administration, and restricted GitHub tools', () => {
  for (const tool of [
    'github_graphrag_observation_receipt_get',
    'github_workflow_run_failed_log_excerpt',
    'github_make_broker',
    'github_contents_delete_file',
    'github_release_delete',
    'github_create_release',
    'github_add_labels',
    'github_workflow_disable',
    'github_workflow_enable',
    'github_ref_create',
    'github_ref_update',
  ]) assert.equal((GITHUB_OPERATOR_TOOLSET as readonly string[]).includes(tool), false, tool);
});

