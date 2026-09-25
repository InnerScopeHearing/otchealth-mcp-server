import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectCfoGraphQualityReceipt } from './cfo-graphrag-quality-receipt.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const version = (value: string) => `sha256:${value}`;
const ids = { x: sha('x'), y: sha('y'), z: sha('z'), negative: sha('negative') };
const versions = { x: version(sha('vx')), y: version(sha('vy')), z: version(sha('vz')), negative: version(sha('vn')) };
const mapping = (slot: keyof typeof ids, group: 'company' | 'company_shared' = 'company') => ({
  canonical_id: ids[slot], source_version: versions[slot], source_group: group,
  source_sha256: versions[slot].slice(7), source_locator_sha256: sha(`locator-${slot}`),
  provenance_receipt_sha256: sha(`provenance-${slot}`),
});
const binding = (slot: keyof typeof ids, caller = 'cfo', room = 'finance') => ({
  canonical_id: ids[slot], source_version: versions[slot], authenticated_caller: caller,
  room, source_index: 'finance-cfo-source-docs', run_scope: 'finance',
  source_current: true, identity_current: true, binding_sha256: sha(`binding-${slot}`),
  source_current_receipt_sha256: sha(`current-${slot}`), identity_current_receipt_sha256: sha(`identity-${slot}`),
});
const coverage = {
  contractVersion: 'brain.contract.v1', sourceSystem: 'synthetic-source', manifestVersion: 'synthetic-manifest',
  expectedScope: 'finance', coverageStatus: 'complete', observedAt: '2026-09-25T00:00:00.000Z',
  counts: { expected: 4, processed: 4, accepted: 4, rejected: 0 }, authoritativeEndReached: true, unexplainedFailures: 0,
};
const contractFields = {
  schema: 'cfo-graphrag-quality-anchor-contract-v1', scope: 'finance',
  anchors: { x: { canonical_id: ids.x, source_version: versions.x }, y: { canonical_id: ids.y, source_version: versions.y },
    z: { canonical_id: ids.z, source_version: versions.z }, negative: { canonical_id: ids.negative, source_version: versions.negative } },
  negative_control_kinds: ['missing_bridge', 'near_match', 'personal_ring', 'reverse'],
};
const contract = { ...contractFields, contract_sha256: sha(canonical(contractFields)) };
const citation = (slot: keyof typeof ids) => ({ canonical_id: ids[slot], source_version: versions[slot] });
const control = (kind: 'reverse' | 'missing_bridge' | 'near_match' | 'personal_ring') => {
  const scope = kind === 'personal_ring' ? 'personal' as const : 'finance' as const;
  const direction = kind === 'reverse' ? 'z_to_x' as const : 'x_to_z' as const;
  const bridge_present = kind !== 'missing_bridge';
  const exact_identity = kind !== 'near_match';
  const anchors = { x: citation('x'), y: citation('y'), z: citation('z'), negative: citation('negative') };
  const query = kind === 'reverse'
    ? { from: 'z' as const, bridge: 'negative' as const, to: 'x' as const }
    : kind === 'missing_bridge'
      ? { from: 'x' as const, bridge: null, to: 'z' as const }
      : { from: 'x' as const, bridge: 'negative' as const, to: 'z' as const };
  const queryDescriptor = { schema: 'cfo-graphrag-negative-query-v1', kind, scope, direction, bridge_present, exact_identity, anchors, query };
  return {
    scope, direction, bridge_present, exact_identity, anchors, query,
    kind, query_sha256: sha(canonical(queryDescriptor)), result_count: 0,
    result_status: kind === 'personal_ring' ? 'forbidden_ring' as const : 'unsupported' as const,
    ...(kind === 'personal_ring' ? {} : { scan_complete: true }), evidence_sha256: sha(`negative-evidence-${kind}`),
  };
};
function input() {
  return {
    caller_agent: 'cfo', contract, coverage,
    citation_mappings: (['x', 'y', 'z', 'negative'] as const).map(slot => mapping(slot)),
    bindings: (['x', 'y', 'z', 'negative'] as const).map(slot => binding(slot)),
    citations: (['x', 'y', 'z', 'negative'] as const).map(citation),
    traversal: { scope: 'finance', scan_complete: true, answer_status: 'qualified',
      query_sha256: sha('x-to-y-to-z'), artifact_sha256: sha('traversal-artifact'),
      edges: [
        { from: 'x', to: 'y', assertion_sha256: sha('xy-assertion'), evidence_sha256: sha('xy-evidence'), identity_receipt_sha256: sha('xy-identity') },
        { from: 'y', to: 'z', assertion_sha256: sha('yz-assertion'), evidence_sha256: sha('yz-evidence'), identity_receipt_sha256: sha('yz-identity') },
      ] },
    negative_controls: (['reverse', 'missing_bridge', 'near_match', 'personal_ring'] as const).map(control),
  };
}

test('projects a CFO finance contract without claiming owner approval or quality acceptance', () => {
  const result = projectCfoGraphQualityReceipt(input());
  assert.equal(result.status, 'contract_validated');
  assert.equal(result.quality_state, 'unproven');
  assert.equal(result.quality_accepted, false);
  assert.equal(result.owner_approval_verified, false);
  assert.equal(result.provenance_verified, false);
  assert.deepEqual(result.blockers, ['owner_approval_provenance_unavailable', 'source_owner_signed_metadata_export_unavailable', 'citation_bound_aggregate_graph_receipt_unavailable']);
  assert.deepEqual(result.coverage_counts, { expected: 4, processed: 4, accepted: 4, rejected: 0 });
  assert.equal(result.declared_citation_count, 4);
  assert.equal(result.declared_binding_count, 4);
  assert.equal(result.declared_edge_count, 2);
  assert.equal(result.declared_negative_control_count, 4);
  assert.equal('negative_controls' in result, false);
});

test('receipt identity is stable when order-independent evidence arrays are reordered', () => {
  const first = projectCfoGraphQualityReceipt(input());
  const reordered = input();
  reordered.citation_mappings.reverse(); reordered.bindings.reverse(); reordered.citations.reverse(); reordered.negative_controls.reverse();
  reordered.contract = { ...reordered.contract, negative_control_kinds: [...reordered.contract.negative_control_kinds].reverse() };
  const second = projectCfoGraphQualityReceipt(reordered);
  assert.equal(first.receipt_id, second.receipt_id);
  assert.equal(first.inputs_sha256, second.inputs_sha256);
});

test('rejects non-CFO callers and company-shared citations', () => {
  assert.equal(projectCfoGraphQualityReceipt({ ...input(), caller_agent: 'cto' }).status, 'rejected');
  const crossScope = input();
  crossScope.citation_mappings[0] = mapping('x', 'company_shared');
  assert.equal(projectCfoGraphQualityReceipt(crossScope).status, 'rejected');
});

test('fails closed on incomplete source coverage and missing, stale, duplicate, or wrong-lane bindings', () => {
  const partial = input();
  partial.coverage = { ...coverage, coverageStatus: 'partial' };
  assert.equal(projectCfoGraphQualityReceipt(partial).status, 'rejected');
  for (const expected of [0, 3]) {
    const insufficient = input();
    insufficient.coverage = { ...coverage, counts: { expected, processed: expected, accepted: expected, rejected: 0 } };
    assert.equal(projectCfoGraphQualityReceipt(insufficient).status, 'rejected');
  }
  for (const mutate of [
    (value: ReturnType<typeof input>) => { value.bindings.pop(); },
    (value: ReturnType<typeof input>) => { value.bindings.push(value.bindings[0]); },
    (value: ReturnType<typeof input>) => { value.bindings[0] = { ...value.bindings[0], source_current: false }; },
    (value: ReturnType<typeof input>) => { value.bindings[0] = { ...value.bindings[0], authenticated_caller: 'clo' }; },
    (value: ReturnType<typeof input>) => { value.bindings[0] = { ...value.bindings[0], room: 'legal_company' }; },
  ]) {
    const value = input(); mutate(value);
    assert.equal(projectCfoGraphQualityReceipt(value).status, 'rejected');
  }
});

test('fails closed on unresolved, stale, or duplicated citation mappings', () => {
  const absent = input(); absent.citation_mappings.pop();
  assert.equal(projectCfoGraphQualityReceipt(absent).status, 'rejected');
  const stale = input(); stale.citations[0] = { ...stale.citations[0], source_version: versions.y };
  assert.equal(projectCfoGraphQualityReceipt(stale).status, 'rejected');
  const duplicate = input(); duplicate.citation_mappings[3] = duplicate.citation_mappings[0];
  assert.equal(projectCfoGraphQualityReceipt(duplicate).status, 'rejected');
  const malformed = input(); malformed.citation_mappings[0] = { canonical_id: ids.x };
  assert.equal(projectCfoGraphQualityReceipt(malformed).status, 'rejected');
  const textBearing = input(); textBearing.citation_mappings[0] = { ...textBearing.citation_mappings[0], source_text: 'never accept or echo' };
  const rejectedText = projectCfoGraphQualityReceipt(textBearing);
  assert.equal(rejectedText.status, 'rejected');
  assert.equal(JSON.stringify(rejectedText).includes('never accept or echo'), false);
});

test('requires a complete directed X to Y to Z traversal with current evidence references', () => {
  const incomplete = input(); incomplete.traversal.scan_complete = false;
  assert.equal(projectCfoGraphQualityReceipt(incomplete).status, 'rejected');
  const reversed = input(); reversed.traversal.edges[0] = { ...reversed.traversal.edges[0], from: 'y', to: 'x' };
  assert.equal(projectCfoGraphQualityReceipt(reversed).status, 'rejected');
  const noIdentityReceipt = input(); noIdentityReceipt.traversal.edges[1] = { ...noIdentityReceipt.traversal.edges[1], identity_receipt_sha256: '' };
  assert.equal(projectCfoGraphQualityReceipt(noIdentityReceipt).status, 'rejected');
});

test('requires all four negative controls and forbids any negative match', () => {
  const missing = input(); missing.negative_controls.pop();
  assert.equal(projectCfoGraphQualityReceipt(missing).status, 'rejected');
  const nearMatch = input(); nearMatch.negative_controls[2] = { ...nearMatch.negative_controls[2], result_count: 1 };
  assert.equal(projectCfoGraphQualityReceipt(nearMatch).status, 'rejected');
  const personal = input(); personal.negative_controls[3] = { ...personal.negative_controls[3], result_status: 'unsupported' };
  assert.equal(projectCfoGraphQualityReceipt(personal).status, 'rejected');
  const falseReverse = input(); falseReverse.negative_controls[0] = { ...falseReverse.negative_controls[0], direction: 'x_to_y' };
  assert.equal(projectCfoGraphQualityReceipt(falseReverse).status, 'rejected');
  const wrongAnchor = input();
  wrongAnchor.negative_controls[0] = { ...wrongAnchor.negative_controls[0], anchors: { ...wrongAnchor.negative_controls[0].anchors, negative: citation('x') } };
  assert.equal(projectCfoGraphQualityReceipt(wrongAnchor).status, 'rejected');
  const wrongQueryRoute = input();
  wrongQueryRoute.negative_controls[1] = { ...wrongQueryRoute.negative_controls[1], query: { from: 'x', bridge: 'negative', to: 'z' } };
  assert.equal(projectCfoGraphQualityReceipt(wrongQueryRoute).status, 'rejected');
  const mismatchedQueryDigest = input();
  mismatchedQueryDigest.negative_controls[2] = { ...mismatchedQueryDigest.negative_controls[2], query_sha256: sha('different-query') };
  assert.equal(projectCfoGraphQualityReceipt(mismatchedQueryDigest).status, 'rejected');
});

test('strict metadata contract rejects source text and paths instead of echoing them', () => {
  const poisoned = input() as ReturnType<typeof input> & { source_text?: string };
  poisoned.source_text = 'must never be returned';
  const result = projectCfoGraphQualityReceipt(poisoned);
  assert.equal(result.status, 'rejected');
  assert.equal(JSON.stringify(result).includes('must never be returned'), false);
});
