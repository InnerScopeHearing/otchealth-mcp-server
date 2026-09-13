import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAIN_CONTRACT_VERSION, type AssertionRecord } from './contracts.js';
import { createEvidenceBackedDecisionBrief, selectEvidenceBackedAssertions, type TrustedAuthorization } from './evidence-view.js';

const at = '2026-09-13T12:00:00.000Z';
const future = '2026-09-14T12:00:00.000Z';
const hash = 'a'.repeat(64);
const context = { actorId: 'reader-1', tenantId: 'tenant-1' };
const allow: TrustedAuthorization = () => true;

function assertion(overrides: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    contractVersion: BRAIN_CONTRACT_VERSION, assertionId: 'assertion-1', recordVersion: 'v1', actorId: 'writer-1', tenantId: 'tenant-1', sourceGeneration: 'generation/1',
    memoryType: 'assertion', lifecycle: 'active', statement: 'Synthetic premise.',
    validTime: { basis: 'exact', start: at, end: future }, recordedAt: at, recordedUntil: null,
    authorization: [{ name: 'internal', policyVersion: 'v1' }], status: 'inferred',
    evidence: [{ evidenceId: 'evidence-1', sourceSystem: 'source', sourceRecordId: '1', immutableVersion: 'v1', sourceGeneration: 'generation/1', actorId: 'writer-1', tenantId: 'tenant-1', contentSha256: hash, span: { offsetUnit: 'utf16', start: 0, end: 1 } }],
    ...overrides,
  } as AssertionRecord;
}

const current = (records: readonly unknown[], authorize = allow) => selectEvidenceBackedAssertions(records, context, { mode: 'current', validAt: at, observedAt: at }, authorize);

test('selects an authorized active assertion and preserves its inferred status in the brief', () => {
  const selected = current([assertion()]);
  assert.equal(selected.length, 1);
  assert.equal(createEvidenceBackedDecisionBrief([assertion()], context, { mode: 'current', validAt: at, observedAt: at }, allow)[0]?.status, 'inferred');
});

test('fails closed when a supporting source is revoked or policy throws', () => {
  const sourceRevoked: TrustedAuthorization = ({ evidence }) => evidence?.sourceSystem !== 'source';
  assert.equal(current([assertion()], sourceRevoked).length, 0);
  assert.equal(current([assertion()], () => { throw new Error('policy unavailable'); }).length, 0);
});

test('does not combine a cross-department denied premise or cross-tenant evidence', () => {
  const deniedDepartment: TrustedAuthorization = ({ assertion: candidate }) => candidate.authorization.every((label) => label.name !== 'finance');
  assert.equal(current([assertion({ authorization: [{ name: 'finance', policyVersion: 'v1' }] })], deniedDepartment).length, 0);
  const wrongTenant = assertion({ evidence: [{ ...assertion().evidence[0]!, tenantId: 'tenant-2' }] });
  assert.equal(current([wrongTenant]).length, 0);
});

test('applies explicit interval semantics for future, open, unknown, and known-as-of time', () => {
  assert.equal(current([assertion({ validTime: { basis: 'exact', start: future, end: null } })]).length, 0);
  assert.equal(current([assertion({ validTime: { basis: 'exact', start: null, end: future } })]).length, 1);
  assert.equal(current([assertion({ validTime: { basis: 'unknown', start: null, end: null } })]).length, 0);
  const revised = assertion({ recordedUntil: future });
  assert.equal(selectEvidenceBackedAssertions([revised], context, { mode: 'known-as-of', validAt: at, observedAt: future, knownAsOf: at }, allow).length, 1);
  assert.equal(selectEvidenceBackedAssertions([revised], context, { mode: 'known-as-of', validAt: at, observedAt: future, knownAsOf: future }, allow).length, 0);
});

test('excludes inactive, malformed, and caller-cross-tenant records without disclosure', () => {
  assert.equal(current([assertion({ lifecycle: 'superseded' }), assertion({ lifecycle: 'retracted' }), assertion({ lifecycle: 'disputed' })]).length, 0);
  assert.equal(current([{ invalid: true }, assertion({ tenantId: 'tenant-2' })]).length, 0);
});

test('current knowledge excludes future or closed records while historical known-as-of retains lifecycle', () => {
  const futureRecorded = assertion({ recordedAt: future });
  const closed = assertion({ recordedUntil: future });
  assert.equal(current([futureRecorded, closed]).length, 1, 'only the open record is currently known');
  assert.equal(current([closed]).length, 1);
  assert.equal(selectEvidenceBackedAssertions([closed], context, { mode: 'current', validAt: at, observedAt: future }, allow).length, 0);
  const historical = assertion({ lifecycle: 'superseded', recordedUntil: future });
  const brief = createEvidenceBackedDecisionBrief([historical], context, { mode: 'known-as-of', validAt: at, observedAt: future, knownAsOf: at }, allow);
  assert.equal(brief[0]?.lifecycle, 'superseded');
  assert.equal(current([historical]).length, 0);
});

test('rejects malformed external query values and blank caller scope at runtime', () => {
  assert.equal(selectEvidenceBackedAssertions([assertion()], context, { mode: 'current', validAt: at, observedAt: 'not-a-time' }, allow).length, 0);
  assert.equal(selectEvidenceBackedAssertions([assertion()], { actorId: ' ', tenantId: 'tenant-1' }, { mode: 'current', validAt: at, observedAt: at }, allow).length, 0);
  assert.equal(selectEvidenceBackedAssertions([assertion()], context, { mode: 'invalid' as 'current', validAt: at, observedAt: at }, allow).length, 0);
  assert.equal(selectEvidenceBackedAssertions('not-an-array' as unknown as unknown[], { actorId: 42, tenantId: 'tenant-1' } as unknown as typeof context, { mode: 'current', validAt: at, observedAt: at }, allow).length, 0);
  assert.equal(selectEvidenceBackedAssertions([assertion()], context, { mode: 'current', validAt: '2026-09-13', observedAt: at }, allow).length, 0);
  assert.equal(selectEvidenceBackedAssertions([assertion()], context, { mode: 'current', validAt: at, observedAt: future }, allow).length, 0);
});
