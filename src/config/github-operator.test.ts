import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  COMPANY_GITHUB_ALLOWED_OWNERS,
  COMPANY_GITHUB_OPERATOR_LANES,
  GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS,
  GITHUB_CONTENT_BEARING_WRITE_TOOLS,
  GITHUB_OPERATOR_TOOLSET,
  GITHUB_OPERATOR_WRITE_TOOLS,
  GITHUB_REPOSITORY_WRITE_TOOLS,
  isCompanyGitHubAllowedOwner,
  isCompanyGitHubOperatorLane,
  isGitHubContentBearingWriteTool,
  isGitHubOperatorTool,
  isGitHubRepositoryWriteTool,
  isGitHubWriteCarvedOutRepository,
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

test('company GitHub owner boundary allows every InnerScopeHearing repo and denies external owners', () => {
  assert.deepEqual(COMPANY_GITHUB_ALLOWED_OWNERS, ['InnerScopeHearing']);
  for (const owner of ['InnerScopeHearing', 'innerscopehearing', 'INNERSCOPEHEARING']) {
    assert.equal(isCompanyGitHubAllowedOwner(owner), true, owner);
  }
  for (const owner of ['', 'InnerScopeHearing-other', 'external-owner', 'openai', null, undefined]) {
    assert.equal(isCompanyGitHubAllowedOwner(owner), false, String(owner));
  }
});

test('MedReview/phi write carveout preserves the existing case-insensitive repository naming rule', () => {
  for (const repo of ['medreview', 'MedReview-App', 'phi-service', 'my-PHI-tools']) {
    assert.equal(isGitHubWriteCarvedOutRepository(repo), true, repo);
  }
  for (const repo of ['otchealth-mcp-server', 'FourVault', '', null, undefined]) {
    assert.equal(isGitHubWriteCarvedOutRepository(repo), false, String(repo));
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
  for (const tool of GITHUB_OPERATOR_TOOLSET) assert.equal(isGitHubOperatorTool(tool), true, tool);
  assert.equal(isGitHubOperatorTool('github_label_create'), false);
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
  for (const tool of GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS) {
    assert.equal((GITHUB_OPERATOR_TOOLSET as readonly string[]).includes(tool), false, `${tool} must stay outside the shared surface`);
  }
});

test('repository write boundary exhaustively covers shared and adjacent direct mutations', () => {
  assert.equal(GITHUB_REPOSITORY_WRITE_TOOLS.length, 36);
  assert.equal(new Set(GITHUB_REPOSITORY_WRITE_TOOLS).size, GITHUB_REPOSITORY_WRITE_TOOLS.length);
  for (const tool of [
    ...GITHUB_OPERATOR_WRITE_TOOLS,
    ...GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS,
    'github_contents_delete_file',
    'github_label_delete',
    'github_milestone_delete',
    'github_release_delete',
    'github_workflow_disable',
    'github_workflow_run_cancel',
  ]) {
    assert.equal(isGitHubRepositoryWriteTool(tool), true, tool);
  }
  for (const tool of [
    'github_make_broker',
    'github_get_file_contents',
    'github_workflow_run_failed_log_excerpt',
    'github_graphrag_observation_receipt_get',
  ]) {
    assert.equal(isGitHubRepositoryWriteTool(tool), false, tool);
  }
});

test('destructive label/release deletion stays outside the CTO/Developer adjacent grant', () => {
  for (const tool of ['github_label_delete', 'github_release_delete']) {
    assert.equal((GITHUB_CTO_DEVELOPER_ADJACENT_WRITE_TOOLS as readonly string[]).includes(tool), false, tool);
    assert.equal(isGitHubRepositoryWriteTool(tool), true, `${tool} must retain repository-write boundaries`);
  }
});

test('repository write boundary matches every registered GitHub mutation source file', () => {
  const githubToolsDirectory = new URL('../tools/github/', import.meta.url);
  const discovered = readdirSync(githubToolsDirectory)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .flatMap((file) => {
      const source = readFileSync(new URL(file, githubToolsDirectory), 'utf8');
      if (!/category:\s*'write_(?:simple|orchestrated)'/.test(source)) return [];
      const literalName = /name:\s*'([^']+)'/.exec(source)?.[1];
      if (literalName) return [literalName];
      return file === 'make-broker.ts' ? ['github_make_broker'] : [];
    })
    .filter((tool) => tool !== 'github_make_broker')
    .sort();
  assert.deepEqual([...GITHUB_REPOSITORY_WRITE_TOOLS].sort(), discovered);
});

test('personal-legal content fence covers every broad GitHub content transport', () => {
  assert.equal(GITHUB_CONTENT_BEARING_WRITE_TOOLS.length, 20);
  assert.equal(new Set(GITHUB_CONTENT_BEARING_WRITE_TOOLS).size, GITHUB_CONTENT_BEARING_WRITE_TOOLS.length);
  for (const tool of GITHUB_CONTENT_BEARING_WRITE_TOOLS) {
    assert.equal(isGitHubRepositoryWriteTool(tool), true, `${tool} must be a direct repository write`);
    assert.equal(isGitHubContentBearingWriteTool(tool), true, tool);
  }
  for (const tool of ['github_pr_update_branch', 'github_ref_delete', 'github_workflow_run_rerun']) {
    assert.equal(isGitHubContentBearingWriteTool(tool), false, tool);
  }
});
