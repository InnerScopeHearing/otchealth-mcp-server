import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptRelationshipAssertions } from './relationship-assertion-adapter.js';

const at = '2026-09-13T12:00:00.000Z';
const later = '2026-09-14T12:00:00.000Z';
const digest = 'a'.repeat(64);
const record = { record_id: 'record-1', accepted: true, recorded_at: at,
  valid_time: { valid_from: at, valid_to: null }, evidence: { source_ref: 'source-1', passage_sha256: digest, chunk_start_byte: 0, chunk_end_byte: 4, source_binding: { chunk_sha256: digest, sidecar_content_sha256: digest } },
  assertion: { semantic_intent: { support: { kind: 'verified_fact', verifier_id: 'verifier-1' }, subject: { entity_id: 'subject-1' }, predicate: 'depends_on', object: { entity_id: 'object-1' }, witness: { source_version: digest, span_start_byte: 0, span_end_byte: 4, span_sha256: digest } } } };
const input = (records: unknown[], corrections: unknown[] = []) => ({ runId: 'run-1', actorId: 'cfo', tenantId: 'finance', policyVersion: 'policy-1', records, corrections });

test('maps only verifier-backed immutable relationship evidence without source text', () => {
  const result = adaptRelationshipAssertions(input([record]));
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, 'verified');
  assert.equal(result[0]?.evidence[0]?.contentSha256, digest);
  assert.match(result[0]?.statement ?? '', /subject-1 depends_on object-1/);
  assert.equal(JSON.stringify(result).includes('source body'), false);
});
test('maps a correction to historical lifecycle and recorded interval', () => {
  const result = adaptRelationshipAssertions(input([record], [{ target_id: 'record-1', replacement_id: 'record-2', recorded_at: later }]));
  assert.equal(result[0]?.lifecycle, 'superseded');
  assert.equal(result[0]?.recordedUntil, later);
});
test('abstains on unverified, malformed, or mismatched temporal/evidence records', () => {
  assert.equal(adaptRelationshipAssertions(input([{ ...record, accepted: false }])).length, 0);
  assert.equal(adaptRelationshipAssertions(input([{ ...record, evidence: { ...record.evidence, passage_sha256: 'bad' } }])).length, 0);
  assert.equal(adaptRelationshipAssertions(input([{ ...record, assertion: { semantic_intent: { ...record.assertion.semantic_intent, witness: { ...record.assertion.semantic_intent.witness, span_end_byte: 5 } } } }])).length, 0);
  assert.equal(adaptRelationshipAssertions(input([record], [{ target_id: 'record-1', replacement_id: 'a', recorded_at: later }, { target_id: 'record-1', replacement_id: 'b', recorded_at: later }])).length, 0);
  assert.equal(adaptRelationshipAssertions(input([{ ...record, valid_time: { valid_from: null, valid_to: null } }], [{ target_id: 'record-1', replacement_id: 'record-2', recorded_at: at }])).length, 0);
});
