import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES,
  PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES,
  companyGraphScopeOwnsBinding,
  companyGraphScopeOwnsSourceKey,
  companyGraphScopeOwnsWorkerKey,
  companyGraphScopeTest,
  resolveCompanyGraphScope,
} from './company-graph-scope.js';

function resolved(caller: string, requested?: string) {
  const result = resolveCompanyGraphScope(caller, requested);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.code);
  return result.scope;
}

test('omitted scope preserves the existing CFO finance binding', () => {
  const scope = resolved('cfo');
  assert.deepEqual(scope, {
    scope: 'finance', authenticatedCaller: 'cfo', room: 'finance',
    sourceIndex: 'finance-cfo-source-docs',
    sourceStore: {
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'otchealthcfodata/cfo-source-docs/',
    },
    workerStore: {
      bucket: 'otchealth-finance-legal-dr-55c84f6b',
      prefix: 'graph-trial/20260908/workers/cfo/',
    },
  });
});

test('CLO company scope resolves only to its server-owned legal binding', () => {
  const scope = resolved('clo', 'legal_company');
  assert.equal(scope.authenticatedCaller, 'clo');
  assert.equal(scope.room, 'legal_company');
  assert.equal(scope.sourceIndex, 'legal-company');
  assert.equal(scope.sourceStore.prefix, 'otchealthlegalstore/company/');
  assert.equal(scope.workerStore.prefix, 'graph-trial/20260908/workers/clo/');
});

test('cross-scope callers and personal scope are denied', () => {
  assert.deepEqual(resolveCompanyGraphScope('cfo', 'legal_company'), { ok: false, code: 'scope_forbidden' });
  assert.deepEqual(resolveCompanyGraphScope('clo', 'finance'), { ok: false, code: 'scope_forbidden' });
  assert.deepEqual(resolveCompanyGraphScope('clo-personal', 'legal_company'), { ok: false, code: 'scope_forbidden' });
  assert.deepEqual(resolveCompanyGraphScope('clo-personal', 'personal_legal'), { ok: false, code: 'unsupported_scope' });
  assert.deepEqual(resolveCompanyGraphScope('clo', 'legal-personal'), { ok: false, code: 'unsupported_scope' });
  assert.deepEqual(resolveCompanyGraphScope('cto', 'finance'), { ok: false, code: 'scope_forbidden' });
});

test('binding ownership requires caller, room, index, and run scope to agree', () => {
  const finance = resolved('cfo');
  const legal = resolved('clo', 'legal_company');
  const financeBinding = {
    authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs',
    run: { scope: 'finance' },
  };
  const legalBinding = {
    authenticated_caller: 'clo', room: 'legal_company', source_index: 'legal-company',
    run: { scope: 'legal_company' },
  };
  assert.equal(companyGraphScopeOwnsBinding(finance, financeBinding), true);
  assert.equal(companyGraphScopeOwnsBinding(legal, legalBinding), true);
  assert.equal(companyGraphScopeOwnsBinding(finance, legalBinding), false);
  assert.equal(companyGraphScopeOwnsBinding(legal, financeBinding), false);
  assert.equal(companyGraphScopeOwnsBinding(legal, { ...legalBinding, source_index: 'legal-personal' }), false);
  assert.equal(companyGraphScopeOwnsBinding(legal, { ...legalBinding, run: { scope: 'finance' } }), false);
});

test('source and worker key ownership reject sibling scopes and traversal', () => {
  const finance = resolved('cfo');
  const legal = resolved('clo', 'legal_company');
  assert.equal(companyGraphScopeOwnsSourceKey(finance, 'otchealthcfodata/cfo-source-docs/_TEXT/a.txt'), true);
  assert.equal(companyGraphScopeOwnsSourceKey(legal, 'otchealthlegalstore/company/_TEXT/a.txt'), true);
  assert.equal(companyGraphScopeOwnsSourceKey(finance, 'otchealthlegalstore/company/_TEXT/a.txt'), false);
  assert.equal(companyGraphScopeOwnsSourceKey(legal, 'otchealthlegalstore/personal/_TEXT/a.txt'), false);
  assert.equal(companyGraphScopeOwnsSourceKey(legal, 'otchealthlegalstore/company/../personal/a.txt'), false);
  assert.equal(companyGraphScopeOwnsWorkerKey(finance, 'graph-trial/20260908/workers/cfo/run_a/state.json'), true);
  assert.equal(companyGraphScopeOwnsWorkerKey(legal, 'graph-trial/20260908/workers/clo/run_a/state.json'), true);
  assert.equal(companyGraphScopeOwnsWorkerKey(finance, 'graph-trial/20260908/workers/clo/run_a/state.json'), false);
  assert.equal(companyGraphScopeOwnsWorkerKey(legal, 'graph-trial/20260908/workers/cfo/run_a/state.json'), false);
  assert.equal(companyGraphScopeOwnsWorkerKey(legal, 'graph-trial/20260908/workers/clo/../cfo/state.json'), false);
});

test('personal legal prerequisites authorize code reuse only and require dedicated authorities', () => {
  assert.equal(PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES.authenticated_caller, 'clo-personal');
  assert.equal(PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES.source_index, 'legal-personal');
  assert.equal(PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES.deployment_boundary, 'separate_privileged_runtime');
  assert.ok(PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES.required_dedicated_authorities.includes('identity_registry'));
  assert.ok(PERSONAL_LEGAL_GRAPH_DEPLOYMENT_PREREQUISITES.forbidden_company_reuse.includes('credential_set'));
  assert.ok(!Object.hasOwn(companyGraphScopeTest.scopes, 'personal_legal'));
});

test('corporate CLO rollout metadata requires scope-bound live acceptance', () => {
  assert.equal(CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES.scope, 'legal_company');
  assert.equal(CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES.authenticated_caller, 'clo');
  assert.ok(CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES.required_configuration_names.includes(
    'GRAPH_RELATIONSHIP_HISTORY_POLICY_JSON',
  ));
  assert.ok(CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES.required_acceptance_receipts.includes(
    'cross_scope_route_denial',
  ));
  assert.ok(CORPORATE_CLO_GRAPH_ROLLOUT_PREREQUISITES.required_acceptance_receipts.includes(
    'fresh_clo_relationship_query',
  ));
});
