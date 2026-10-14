import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAIN_CONTRACT_VERSION, type AssertionRecord } from './contracts.js';
import {
  selectCurrentAssertions,
  type SourceAuthorityReceiptV1,
  type SourceCurrentnessQueryV1,
} from './source-authority-adapter.js';

const at = '2026-10-13T12:00:00.000Z';
const future = '2027-01-01T00:00:00.000Z';
const hash = 'a'.repeat(64);
const context = { actorId: 'reader-1', tenantId: 'tenant-1' };

function assertion(overrides: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    contractVersion: BRAIN_CONTRACT_VERSION,
    assertionId: 'assertion-1', recordVersion: 'v1', actorId: 'recorder-1', tenantId: 'tenant-1',
    sourceGeneration: 'ingest-generation-1', memoryType: 'assertion', lifecycle: 'active',
    statement: 'Synthetic source assertion.',
    validTime: { basis: 'exact', start: at, end: future }, recordedAt: at, recordedUntil: null,
    authorization: [{ name: 'internal', policyVersion: 'policy-v1' }], status: 'inferred',
    evidence: [{ evidenceId: 'evidence-1', sourceSystem: 'finance', sourceRecordId: 'native-row-7',
      immutableVersion: 'native-version-7', sourceGeneration: 'ingest-generation-1', actorId: 'recorder-1',
      tenantId: 'tenant-1', contentSha256: hash,
      span: { offsetUnit: 'codepoint', start: 0, end: 1 } }],
    ...overrides,
  } as AssertionRecord;
}

function receipt(record = assertion(), overrides: Partial<SourceAuthorityReceiptV1> = {}): SourceAuthorityReceiptV1 {
  const evidence = record.evidence[0]!;
  return {
    contractVersion: 'source-authority.receipt.v1', receiptId: 'receipt-1',
    knownAsOf: at, validAt: at, assertionId: record.assertionId, recordVersion: record.recordVersion,
    evidenceId: evidence.evidenceId, sourceId: 'finance.native_records', sourceSystem: evidence.sourceSystem,
    sourceRecordId: evidence.sourceRecordId, immutableVersion: evidence.immutableVersion,
    sourceGeneration: evidence.sourceGeneration, ownerRef: 'owner:cfo',
    authorityState: 'confirmed', applicability: true, governingCurrent: true,
    ...overrides,
  };
}

function query(records: readonly unknown[], resolve: SourceCurrentnessQueryV1['authorityBoundary']['resolve'] | undefined): SourceCurrentnessQueryV1 {
  return {
    contractVersion: 'source-currentness.query.v1', assertions: records,
    validAt: at, knownAsOf: at, observedAt: at, context,
    authorize: ({ context: reader, evidence }) => reader.tenantId === 'tenant-1' && (!evidence || evidence.tenantId === 'tenant-1'),
    authorityBoundary: resolve ? { resolve } : undefined,
  };
}

test('selects current only from a trusted, fully bound owner receipt and keeps evidence pins distinct', () => {
  const record = assertion();
  const result = selectCurrentAssertions(query([record], () => ({ state: 'resolved', receipts: [receipt(record)] })));
  assert.equal(result.records[0]?.disposition, 'current');
  assert.equal(result.records[0]?.recordRef, 'assertion-1@v1');
  assert.equal(result.records[0]?.evidence[0]?.sourceGeneration, 'ingest-generation-1');
  assert.equal(result.records[0]?.evidence[0]?.immutableVersion, 'native-version-7');
  assert.equal(result.records[0]?.ownerRefs[0], 'owner:cfo');
});

test('requires a separately bound owner receipt for every evidence reference', () => {
  const base = assertion();
  const secondEvidence = { ...base.evidence[0]!, evidenceId: 'evidence-2', sourceSystem: 'operations',
    sourceRecordId: 'native-job-9', immutableVersion: 'native-version-9', sourceGeneration: 'ingest-generation-2' };
  const record = assertion({ evidence: [base.evidence[0]!, secondEvidence] });
  const secondReceipt = receipt(record, { receiptId: 'receipt-2', evidenceId: 'evidence-2', sourceId: 'ops.native_records',
    sourceSystem: 'operations', sourceRecordId: 'native-job-9', immutableVersion: 'native-version-9',
    sourceGeneration: 'ingest-generation-2', ownerRef: 'owner:coo' });
  const resolved = selectCurrentAssertions(query([record], () => ({ state: 'resolved', receipts: [receipt(record), secondReceipt] })));
  assert.equal(resolved.records[0]?.disposition, 'current');
  assert.equal(resolved.records[0]?.evidence.length, 2);
  assert.deepEqual(resolved.records[0]?.ownerRefs, ['owner:cfo', 'owner:coo']);

  const incomplete = selectCurrentAssertions(query([record], () => ({ state: 'resolved', receipts: [receipt(record)] })));
  assert.equal(incomplete.records[0]?.disposition, 'unknown');
  assert.equal(incomplete.records[0]?.reason, 'authority_binding_mismatch');
});

test('resolves recorded time before valid time and preserves explicit open start versus unknown basis', () => {
  const correction = assertion({ recordedAt: future });
  const before = selectCurrentAssertions(query([correction], () => ({ state: 'resolved', receipts: [receipt(correction)] })));
  assert.equal(before.records.length, 0);
  const open = assertion({ validTime: { basis: 'exact', start: null, end: future } });
  assert.equal(selectCurrentAssertions(query([open], () => ({ state: 'resolved', receipts: [receipt(open)] }))).records[0]?.disposition, 'current');
  const unknown = assertion({ validTime: { basis: 'unknown', start: null, end: null } });
  assert.equal(selectCurrentAssertions(query([unknown], () => ({ state: 'resolved', receipts: [receipt(unknown)] }))).records[0]?.reason, 'valid_time_unknown');
});

test('fails closed on authority conflict, outage, missing evidence, and source binding mismatch', () => {
  const record = assertion();
  const conflict = selectCurrentAssertions(query([record], () => ({ state: 'conflict', receipts: [] })));
  assert.equal(conflict.records[0]?.disposition, 'unknown');
  assert.equal(conflict.records[0]?.reason, 'authority_conflict');
  const outage = selectCurrentAssertions(query([record], () => { throw new Error('offline'); }));
  assert.equal(outage.records[0]?.reason, 'authority_outage');
  const noResolver = selectCurrentAssertions(query([record], undefined));
  assert.equal(noResolver.records[0]?.disposition, 'unknown');
  assert.equal(noResolver.records[0]?.reason, 'authority_resolver_unavailable');
  const noReceipt = selectCurrentAssertions(query([record], () => ({ state: 'missing', receipts: [] })));
  assert.equal(noReceipt.records[0]?.reason, 'authority_receipt_missing');
  const missingEvidence = assertion({ evidence: [] });
  assert.equal(selectCurrentAssertions(query([missingEvidence], () => ({ state: 'resolved', receipts: [] }))).records[0]?.reason, 'evidence_missing');
  const mismatched = selectCurrentAssertions(query([record], () => ({ state: 'resolved', receipts: [receipt(record, { immutableVersion: 'ingest-generation-1' })] })));
  assert.equal(mismatched.records[0]?.reason, 'authority_binding_mismatch');
});

test('conflicting governing sources remain unknown and denied assertions are omitted', () => {
  const first = assertion();
  const second = assertion({ assertionId: 'assertion-2', recordVersion: 'v2' });
  const result = selectCurrentAssertions(query([first, second], (input) => ({ state: 'resolved', receipts: [receipt(input.assertionId === first.assertionId ? first : second, { receiptId: `receipt-${input.assertionId}` })] })));
  assert.deepEqual(result.records.map((record) => record.disposition), ['unknown', 'unknown']);
  assert.ok(result.records.every((record) => record.reason === 'governing_source_conflict'));

  const denied = { ...query([first], () => ({ state: 'resolved', receipts: [receipt(first)] })),
    authorize: () => false };
  assert.equal(selectCurrentAssertions(denied).records.length, 0);
});

test('does not promote a candidate when same-assertion authorization or correction state is unavailable', () => {
  const current = assertion({ recordVersion: 'v1' });
  const competing = assertion({ recordVersion: 'v2' });
  const resolveCurrent = (input: { recordVersion: string }) => ({
    state: 'resolved' as const, receipts: input.recordVersion === 'v1' ? [receipt(current)] : [],
  });
  const authorizationOutage = selectCurrentAssertions({
    ...query([current, competing], resolveCurrent),
    authorize: ({ assertion: candidate }) => {
      if (candidate.recordVersion === 'v2') throw new Error('authorization state unavailable');
      return true;
    },
  });
  assert.equal(authorizationOutage.state, 'partial');
  assert.notEqual(authorizationOutage.records.find((record) => record.recordRef === 'assertion-1@v1')?.disposition, 'current');

  const missingCorrectionState = { ...competing } as Record<string, unknown>;
  delete missingCorrectionState.recordedUntil;
  const correctionOutage = selectCurrentAssertions(query([current, missingCorrectionState], resolveCurrent));
  assert.equal(correctionOutage.state, 'partial');
  assert.notEqual(correctionOutage.records.find((record) => record.recordRef === 'assertion-1@v1')?.disposition, 'current');

  const deniedCompetitor = selectCurrentAssertions({
    ...query([current, competing], resolveCurrent),
    authorize: ({ assertion: candidate }) => candidate.recordVersion !== 'v2',
  });
  assert.equal(deniedCompetitor.state, 'complete');
  assert.equal(deniedCompetitor.records[0]?.disposition, 'current');
});
