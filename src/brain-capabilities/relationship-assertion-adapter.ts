import { assertionRecordSchema, type AssertionRecord } from './contracts.js';

/** Sanitized, already-authorized relationship records. Source bodies are intentionally absent. */
export type RelationshipAssertionInput = Readonly<{
  runId: string;
  actorId: string;
  tenantId: string;
  policyVersion: string;
  records: readonly unknown[];
  corrections: readonly unknown[];
}>;

const utc = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = (prefix: string, value: unknown): string | null => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(value)) return null;
  return `${prefix}${value.replace(/[^A-Za-z0-9._:-]/g, '_')}`;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

/**
 * Projects only records carrying an existing verified semantic assertion and immutable span witness.
 * This is structural adaptation, not a verifier: accepted flags alone never become `verified`.
 */
export function adaptRelationshipAssertions(input: RelationshipAssertionInput): AssertionRecord[] {
  if (!input || !id('', input.runId) || !id('', input.actorId) || !id('', input.tenantId) || !id('', input.policyVersion)) return [];
  const ends = new Map<string, string>(), ambiguous = new Set<string>();
  for (const correction of input.corrections) {
    const item = correction as { target_id?: unknown; replacement_id?: unknown; recorded_at?: unknown };
    if (typeof item?.target_id === 'string' && typeof item.replacement_id === 'string' && utc(item.recorded_at)) {
      if (ends.has(item.target_id)) ambiguous.add(item.target_id); else ends.set(item.target_id, item.recorded_at);
    }
  }
  const output: AssertionRecord[] = [];
  for (const raw of input.records) {
    const record = raw as Record<string, any>;
    const recordId = id('assertion_', record?.record_id);
    const evidence = record?.evidence;
    const valid = record?.valid_time;
    const semantic = record?.assertion?.semantic_intent;
    const witness = semantic?.witness;
    const verified = semantic?.support?.kind === 'verified_fact';
    const sourceRef = id('source_', evidence?.source_ref), version = witness?.source_version;
    const spanStart = evidence?.chunk_start_byte, spanEnd = evidence?.chunk_end_byte;
    const subject = semantic?.subject?.entity_id, predicate = semantic?.predicate, object = semantic?.object?.entity_id;
    if (!recordId || record?.accepted !== true || !verified || !utc(record?.recorded_at) || !sourceRef || !hash(evidence?.passage_sha256)
      || !hash(version) || evidence?.source_binding?.chunk_sha256 !== version || evidence?.source_binding?.sidecar_content_sha256 !== version || !Number.isInteger(spanStart) || !Number.isInteger(spanEnd) || spanStart < 0 || spanEnd <= spanStart || witness?.span_start_byte !== spanStart || witness?.span_end_byte !== spanEnd || witness?.span_sha256 !== evidence.passage_sha256 || typeof subject !== 'string' || typeof predicate !== 'string' || typeof object !== 'string' || ambiguous.has(record.record_id)
      || !valid || !utc(valid.valid_from) && valid.valid_from !== null || !utc(valid.valid_to) && valid.valid_to !== null) continue;
    const recordedUntil = ends.get(record.record_id) ?? null;
    if (recordedUntil !== null && Date.parse(recordedUntil) <= Date.parse(record.recorded_at)) continue;
    const candidate = {
      contractVersion: 'brain.contract.v1' as const, assertionId: recordId, recordVersion: `run_${input.runId}`,
      actorId: input.actorId, tenantId: input.tenantId, sourceGeneration: input.runId,
      memoryType: 'assertion' as const, lifecycle: recordedUntil ? 'superseded' as const : 'active' as const,
      statement: `typed relationship: ${subject} ${predicate} ${object}`,
      validTime: valid.valid_from === null && valid.valid_to === null
        ? { basis: 'unknown' as const, start: null, end: null }
        : { basis: 'exact' as const, start: valid.valid_from, end: valid.valid_to },
      recordedAt: record.recorded_at, recordedUntil,
      authorization: [{ name: 'relationship-publication', policyVersion: input.policyVersion }],
      evidence: [{ evidenceId: `e_${evidence.passage_sha256}`, sourceSystem: 'relationship-publication', sourceRecordId: sourceRef,
        immutableVersion: version, sourceGeneration: input.runId, actorId: input.actorId, tenantId: input.tenantId,
        contentSha256: evidence.passage_sha256, span: { offsetUnit: 'bytes' as const, start: spanStart, end: spanEnd } }],
      status: 'verified' as const,
      verification: { method: 'relationship-verifier', verifiedAt: record.recorded_at, verifier: semantic.support.verifier_id,
        evidenceIds: [`e_${evidence.passage_sha256}`] },
    };
    const parsed = assertionRecordSchema.safeParse(candidate);
    if (parsed.success) output.push(parsed.data);
  }
  return output;
}
