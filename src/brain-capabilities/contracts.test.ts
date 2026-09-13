import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRAIN_CONTRACT_VERSION,
  assertionRecordSchema,
  evidenceReferenceSchema,
  idempotencyEnvelopeSchema,
  persistenceReceiptSchema,
  sourceCoverageSchema,
  timeIntervalSchema,
} from './contracts.js';

const at = '2026-09-13T12:00:00.000Z';
const hash = 'a'.repeat(64);
const evidence = {
  evidenceId: 'evidence-1', sourceSystem: 'source', sourceRecordId: '001/record+1', immutableVersion: 'S3Version/abc+123', sourceGeneration: 'generation/1', actorId: 'actor-1', tenantId: 'tenant-1',
  contentSha256: hash, span: { offsetUnit: 'utf16', start: 0, end: 12 },
};
const baseAssertion = {
  contractVersion: BRAIN_CONTRACT_VERSION, assertionId: 'assertion-1', recordVersion: 'v1',
  actorId: 'actor-1', tenantId: 'tenant-1', sourceGeneration: 'generation/1',
  memoryType: 'assertion', lifecycle: 'active', statement: 'Synthetic contract fixture.',
  validTime: { basis: 'exact', start: at, end: '2026-09-14T12:00:00.000Z' }, recordedAt: at, recordedUntil: null,
  authorization: [{ name: 'internal', policyVersion: 'v1' }], evidence: [evidence],
};

test('accepts a verified assertion only with method and linked immutable evidence', () => {
  const result = assertionRecordSchema.parse({
    ...baseAssertion, status: 'verified',
    verification: { method: 'human-review', verifiedAt: at, verifier: 'reviewer-1', evidenceIds: ['evidence-1'] },
  });
  assert.equal(result.status, 'verified');
});

test('rejects a verified assertion without evidence or a known evidence reference', () => {
  const result = assertionRecordSchema.safeParse({
    ...baseAssertion, evidence: [], status: 'verified',
    verification: { method: 'human-review', verifiedAt: at, verifier: 'reviewer-1', evidenceIds: ['missing'] },
  });
  assert.equal(result.success, false);
});

test('inferred records cannot attach a verified claim', () => {
  const result = assertionRecordSchema.safeParse({
    ...baseAssertion, status: 'inferred',
    verification: { method: 'human-review', verifiedAt: at, verifier: 'reviewer-1', evidenceIds: ['evidence-1'] },
  });
  assert.equal(result.success, false);
});

test('accepts opaque external source identifiers but rejects malformed internal IDs, spans, and intervals', () => {
  assert.equal(evidenceReferenceSchema.safeParse(evidence).success, true);
  assert.equal(evidenceReferenceSchema.safeParse({ ...evidence, evidenceId: '1-invalid' }).success, false);
  assert.equal(evidenceReferenceSchema.safeParse({ ...evidence, contentSha256: 'not-a-hash' }).success, false);
  assert.equal(evidenceReferenceSchema.safeParse({ ...evidence, span: { offsetUnit: 'bytes', start: 3, end: 3 } }).success, false);
  assert.equal(timeIntervalSchema.safeParse({ basis: 'exact', start: '2026-09-14T00:00:00Z', end: at }).success, false);
  assert.equal(timeIntervalSchema.safeParse({ basis: 'exact', start: '2026-09-13T12:00:00+99:00', end: null }).success, false);
  assert.equal(timeIntervalSchema.safeParse({ basis: 'unknown', start: null, end: null }).success, true);
  assert.equal(timeIntervalSchema.safeParse({ basis: 'exact', start: null, end: at }).success, true);
});

test('rejects duplicated evidence and invalid recorded-time intervals', () => {
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'unknown', evidence: [evidence, evidence] }).success, false);
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'unknown', recordedUntil: at }).success, false);
  const verification = { method: 'human-review', verifiedAt: at, verifier: 'reviewer-1', evidenceIds: ['evidence-1'] };
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'verified', verification, recordedUntil: at }).success, false);
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'verified', verification, recordedUntil: '2026-09-12T12:00:00.000Z' }).success, false);
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'verified', verification, evidence: [evidence, evidence] }).success, false);
  assert.equal(assertionRecordSchema.safeParse({ ...baseAssertion, status: 'verified', verification: { ...verification, evidenceIds: ['evidence-1', 'evidence-1'] } }).success, false);
});

test('source coverage rejects impossible counts and unqualified complete states', () => {
  const coverage = {
    contractVersion: BRAIN_CONTRACT_VERSION, sourceSystem: 'source', manifestVersion: 'v1', expectedScope: 'synthetic',
    coverageStatus: 'complete', observedAt: at, counts: { expected: 2, processed: 2, accepted: 2, rejected: 0 }, authoritativeEndReached: true, unexplainedFailures: 0,
  };
  assert.equal(sourceCoverageSchema.safeParse(coverage).success, true);
  assert.equal(sourceCoverageSchema.safeParse({ ...coverage, counts: { expected: 2, processed: 1, accepted: 1, rejected: 0 } }).success, false);
  assert.equal(sourceCoverageSchema.safeParse({ ...coverage, counts: { expected: 2, processed: 2, accepted: 2, rejected: 1 } }).success, false);
  assert.equal(sourceCoverageSchema.safeParse({ ...coverage, counts: { expected: null, processed: 2, accepted: 2, rejected: 0 } }).success, false);
  assert.equal(sourceCoverageSchema.safeParse({ ...coverage, authoritativeEndReached: false }).success, false);
});

test('idempotency and persistence receipts distinguish a committed outcome from unknown', () => {
  const envelope = { contractVersion: BRAIN_CONTRACT_VERSION, operationId: 'operation-1', idempotencyKey: 'idempotency-key-0001', actorId: 'actor-1', tenantId: 'tenant-1', requestedAt: at, payload: { kind: 'synthetic' } };
  assert.equal(idempotencyEnvelopeSchema.safeParse(envelope).success, true);
  const receiptBase = { contractVersion: BRAIN_CONTRACT_VERSION, operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey };
  assert.equal(persistenceReceiptSchema.safeParse({ ...receiptBase, receiptId: 'receipt-1', persistenceState: 'committed', recordedAt: at, recordId: 'assertion-1' }).success, true);
  assert.equal(persistenceReceiptSchema.safeParse({ ...receiptBase, receiptId: 'receipt-2', persistenceState: 'unknown', recordId: 'assertion-1' }).success, false);
});
