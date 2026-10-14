import { z } from 'zod';
import { assertionRecordSchema, type AssertionRecord, type EvidenceReference } from './contracts.js';
import type { EvidenceViewContext, TrustedAuthorization } from './evidence-view.js';

export const SOURCE_CURRENTNESS_QUERY_VERSION = 'source-currentness.query.v1' as const;
export const SOURCE_AUTHORITY_RECEIPT_VERSION = 'source-authority.receipt.v1' as const;

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)));
const flag = z.union([z.boolean(), z.literal('unknown')]);

const sourceAuthorityReceiptSchema = z.object({
  contractVersion: z.literal(SOURCE_AUTHORITY_RECEIPT_VERSION),
  receiptId: identifier,
  knownAsOf: timestamp,
  validAt: timestamp,
  assertionId: identifier,
  recordVersion: identifier,
  evidenceId: identifier,
  sourceId: identifier,
  sourceSystem: identifier,
  sourceRecordId: z.string().min(1).max(1_024),
  immutableVersion: z.string().min(1).max(1_024),
  sourceGeneration: z.string().min(1).max(1_024),
  ownerRef: identifier,
  authorityState: z.enum(['confirmed', 'unknown']),
  applicability: flag,
  governingCurrent: flag,
}).strict();

export type SourceAuthorityReceiptV1 = z.infer<typeof sourceAuthorityReceiptSchema>;

export type SourceAuthorityLookupV1 = Readonly<{
  context: EvidenceViewContext;
  assertionId: string;
  recordVersion: string;
  knownAsOf: string;
  validAt: string;
  evidence: readonly EvidenceReference[];
}>;

export type SourceAuthorityResolutionV1 = Readonly<{
  state: 'resolved' | 'missing' | 'conflict' | 'outage';
  receipts: readonly unknown[];
}>;

/** Server-owned seam. Do not construct this from assertion fields, search hits, or caller booleans. */
export type TrustedSourceAuthorityBoundaryV1 = Readonly<{
  resolve: (input: SourceAuthorityLookupV1) => SourceAuthorityResolutionV1;
}>;

export type SourceCurrentnessQueryV1 = Readonly<{
  contractVersion: typeof SOURCE_CURRENTNESS_QUERY_VERSION;
  /** One same-claim candidate set. Call separately for unrelated claims; statement text is never parsed to group them. */
  assertions: readonly unknown[];
  validAt: string;
  knownAsOf: string;
  observedAt: string;
  context: EvidenceViewContext;
  authorize: TrustedAuthorization;
  /** Injected by the authorized gateway integration. Omission never means trusted. */
  authorityBoundary?: TrustedSourceAuthorityBoundaryV1;
}>;

export type CurrentnessDispositionV1 = 'current' | 'history' | 'unknown';
export type SourceCurrentnessRecordV1 = Readonly<{
  recordRef: string;
  disposition: CurrentnessDispositionV1;
  reason: string;
  lifecycle: AssertionRecord['lifecycle'];
  evidence: readonly EvidenceReference[];
  sourceIds: readonly string[];
  ownerRefs: readonly string[];
}>;

export type SourceCurrentnessResultV1 = Readonly<{
  contractVersion: typeof SOURCE_CURRENTNESS_QUERY_VERSION;
  state: 'complete' | 'partial' | 'unknown';
  knownAsOf: string | null;
  validAt: string | null;
  records: readonly SourceCurrentnessRecordV1[];
  reasons: readonly string[];
}>;

function parsedTime(value: unknown): number | null {
  const parsed = timestamp.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : null;
}

function knownAt(assertion: AssertionRecord, point: number): boolean {
  const start = Date.parse(assertion.recordedAt);
  const end = assertion.recordedUntil === null ? null : Date.parse(assertion.recordedUntil);
  return Number.isFinite(start) && start <= point && (end === null || (Number.isFinite(end) && point < end));
}

function effectiveAt(assertion: AssertionRecord, point: number): 'active' | 'future' | 'ended' | 'unknown' {
  if (assertion.validTime.basis !== 'exact') return 'unknown';
  const start = assertion.validTime.start === null ? null : Date.parse(assertion.validTime.start);
  const end = assertion.validTime.end === null ? null : Date.parse(assertion.validTime.end);
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end))) return 'unknown';
  if (start !== null && point < start) return 'future';
  if (end !== null && point >= end) return 'ended';
  return 'active';
}

function resultRecord(
  assertion: AssertionRecord,
  disposition: CurrentnessDispositionV1,
  reason: string,
  receipts: readonly SourceAuthorityReceiptV1[] = [],
): SourceCurrentnessRecordV1 {
  return {
    recordRef: `${assertion.assertionId}@${assertion.recordVersion}`,
    disposition,
    reason,
    lifecycle: assertion.lifecycle,
    evidence: assertion.evidence,
    sourceIds: [...new Set(receipts.map((receipt) => receipt.sourceId))].sort(),
    ownerRefs: [...new Set(receipts.map((receipt) => receipt.ownerRef))].sort(),
  };
}

function receiptMatchesEvidence(
  receipt: SourceAuthorityReceiptV1,
  assertion: AssertionRecord,
  evidence: EvidenceReference,
  knownAsOf: string,
  validAt: string,
): boolean {
  return receipt.assertionId === assertion.assertionId
    && receipt.recordVersion === assertion.recordVersion
    && receipt.evidenceId === evidence.evidenceId
    && receipt.sourceSystem === evidence.sourceSystem
    && receipt.sourceRecordId === evidence.sourceRecordId
    && receipt.immutableVersion === evidence.immutableVersion
    && receipt.sourceGeneration === evidence.sourceGeneration
    && Date.parse(receipt.knownAsOf) === Date.parse(knownAsOf)
    && Date.parse(receipt.validAt) === Date.parse(validAt);
}

function authorized(query: SourceCurrentnessQueryV1, assertion: AssertionRecord): 'allow' | 'deny' | 'outage' {
  try {
    if (query.authorize({ context: query.context, assertion }) !== true) return 'deny';
    for (const evidence of assertion.evidence) {
      if (evidence.tenantId !== query.context.tenantId
        || query.authorize({ context: query.context, assertion, evidence }) !== true) return 'deny';
    }
    return 'allow';
  } catch {
    return 'outage';
  }
}

function unknownResult(reason: string, knownAsOf: string | null = null, validAt: string | null = null): SourceCurrentnessResultV1 {
  return { contractVersion: SOURCE_CURRENTNESS_QUERY_VERSION, state: 'unknown', knownAsOf, validAt, records: [], reasons: [reason] };
}

/**
 * Selects a bitemporal, authorized set of assertions and resolves source authority
 * before any caller may rank them. This is a pure adapter seam; it is not wired to
 * search or a live source-owner register in this change.
 */
export function selectCurrentAssertions(query: SourceCurrentnessQueryV1): SourceCurrentnessResultV1 {
  if (!query || query.contractVersion !== SOURCE_CURRENTNESS_QUERY_VERSION || !Array.isArray(query.assertions)) {
    return unknownResult('query_invalid');
  }
  const validPoint = parsedTime(query.validAt);
  const knownPoint = parsedTime(query.knownAsOf);
  const observedPoint = parsedTime(query.observedAt);
  if (validPoint === null || knownPoint === null || observedPoint === null || knownPoint > observedPoint) {
    return unknownResult('query_time_invalid', typeof query.knownAsOf === 'string' ? query.knownAsOf : null,
      typeof query.validAt === 'string' ? query.validAt : null);
  }
  if (!query.context || typeof query.context.actorId !== 'string' || !query.context.actorId.trim()
    || typeof query.context.tenantId !== 'string' || !query.context.tenantId.trim()
    || typeof query.authorize !== 'function') {
    return unknownResult('authorization_context_unavailable', query.knownAsOf, query.validAt);
  }

  const resultRows: SourceCurrentnessRecordV1[] = [];
  const candidates: number[] = [];
  const reasons = new Set<string>();
  let partial = false;

  for (const raw of query.assertions) {
    const parsed = assertionRecordSchema.safeParse(raw);
    if (!parsed.success) { partial = true; reasons.add('assertion_invalid'); continue; }
    const assertion = parsed.data;
    if (assertion.tenantId !== query.context.tenantId) continue;
    const access = authorized(query, assertion);
    if (access === 'deny') continue;
    if (access === 'outage') { partial = true; reasons.add('authorization_outage'); continue; }

    // Recorded-time visibility is selected before effective-time and authority evaluation.
    if (!knownAt(assertion, knownPoint)) continue;
    if (assertion.lifecycle === 'superseded' || assertion.lifecycle === 'retracted') {
      resultRows.push(resultRecord(assertion, 'history', `lifecycle_${assertion.lifecycle}`));
      continue;
    }
    if (assertion.lifecycle === 'disputed') {
      resultRows.push(resultRecord(assertion, 'unknown', 'lifecycle_disputed'));
      partial = true; reasons.add('lifecycle_disputed'); continue;
    }
    if (assertion.lifecycle !== 'active') {
      resultRows.push(resultRecord(assertion, 'unknown', 'lifecycle_unknown'));
      partial = true; reasons.add('lifecycle_unknown'); continue;
    }

    const effective = effectiveAt(assertion, validPoint);
    if (effective === 'unknown') {
      resultRows.push(resultRecord(assertion, 'unknown', 'valid_time_unknown'));
      partial = true; reasons.add('valid_time_unknown'); continue;
    }
    if (effective === 'future') {
      resultRows.push(resultRecord(assertion, 'unknown', 'not_yet_effective'));
      partial = true; reasons.add('not_yet_effective'); continue;
    }
    if (effective === 'ended') {
      resultRows.push(resultRecord(assertion, 'history', 'validity_ended'));
      continue;
    }
    if (assertion.evidence.length === 0) {
      resultRows.push(resultRecord(assertion, 'unknown', 'evidence_missing'));
      partial = true; reasons.add('evidence_missing'); continue;
    }
    if (!query.authorityBoundary || typeof query.authorityBoundary.resolve !== 'function') {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_resolver_unavailable'));
      partial = true; reasons.add('authority_resolver_unavailable'); continue;
    }

    let resolution: SourceAuthorityResolutionV1;
    try {
      resolution = query.authorityBoundary.resolve({ context: query.context, assertionId: assertion.assertionId,
        recordVersion: assertion.recordVersion, knownAsOf: query.knownAsOf, validAt: query.validAt, evidence: assertion.evidence });
    } catch {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_outage'));
      partial = true; reasons.add('authority_outage'); continue;
    }
    if (!resolution || !['resolved', 'missing', 'conflict', 'outage'].includes(resolution.state)
      || !Array.isArray(resolution.receipts)) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_response_invalid'));
      partial = true; reasons.add('authority_response_invalid'); continue;
    }
    if (resolution.state !== 'resolved') {
      const reason = resolution.state === 'outage' ? 'authority_outage'
        : resolution.state === 'conflict' ? 'authority_conflict' : 'authority_receipt_missing';
      resultRows.push(resultRecord(assertion, 'unknown', reason));
      partial = true; reasons.add(reason); continue;
    }
    if (resolution.receipts.length === 0) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_receipt_missing'));
      partial = true; reasons.add('authority_receipt_missing'); continue;
    }
    if (resolution.receipts.length > assertion.evidence.length || resolution.receipts.length > 100) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_binding_mismatch'));
      partial = true; reasons.add('authority_binding_mismatch'); continue;
    }

    const receipts: SourceAuthorityReceiptV1[] = [];
    let malformed = false;
    for (const rawReceipt of resolution.receipts) {
      const checked = sourceAuthorityReceiptSchema.safeParse(rawReceipt);
      if (!checked.success || receipts.some((receipt) => receipt.receiptId === checked.data.receiptId)) {
        malformed = true; break;
      }
      receipts.push(checked.data);
    }
    if (malformed || receipts.length !== assertion.evidence.length
      || assertion.evidence.some((evidence) => receipts.filter((receipt) => receipt.evidenceId === evidence.evidenceId).length !== 1)
      || receipts.some((receipt) => !assertion.evidence.some((evidence) => receiptMatchesEvidence(receipt, assertion, evidence, query.knownAsOf, query.validAt)))) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_binding_mismatch'));
      partial = true; reasons.add('authority_binding_mismatch'); continue;
    }
    if (receipts.some((receipt) => receipt.authorityState !== 'confirmed' || receipt.applicability === 'unknown'
      || receipt.governingCurrent === 'unknown' || !receipt.ownerRef)) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_unknown', receipts));
      partial = true; reasons.add('authority_unknown'); continue;
    }
    const applicable = new Set(receipts.map((receipt) => receipt.applicability));
    const governing = new Set(receipts.map((receipt) => receipt.governingCurrent));
    if (applicable.size > 1 || governing.size > 1) {
      resultRows.push(resultRecord(assertion, 'unknown', 'authority_evidence_conflict', receipts));
      partial = true; reasons.add('authority_evidence_conflict'); continue;
    }
    if (applicable.has(false)) {
      resultRows.push(resultRecord(assertion, 'history', 'not_applicable', receipts)); continue;
    }
    if (governing.has(false)) {
      resultRows.push(resultRecord(assertion, 'history', 'not_governing_current_source', receipts)); continue;
    }
    candidates.push(resultRows.length);
    resultRows.push(resultRecord(assertion, 'unknown', 'eligible_governing_candidate', receipts));
  }

  if (candidates.length > 1) {
    for (const index of candidates) resultRows[index] = { ...resultRows[index]!, disposition: 'unknown', reason: 'governing_source_conflict' };
    partial = true; reasons.add('governing_source_conflict');
  } else if (candidates.length === 1 && (partial || resultRows.some((row, index) => (
    row.disposition === 'unknown' && !candidates.includes(index)
  )))) {
    const index = candidates[0]!;
    resultRows[index] = { ...resultRows[index]!, disposition: 'unknown', reason: 'currentness_competitor_unknown' };
    partial = true; reasons.add('currentness_competitor_unknown');
  } else if (candidates.length === 1) {
    const index = candidates[0]!;
    resultRows[index] = { ...resultRows[index]!, disposition: 'current', reason: 'trusted_source_current_at_query_time' };
  }

  return {
    contractVersion: SOURCE_CURRENTNESS_QUERY_VERSION,
    state: partial ? 'partial' : 'complete',
    knownAsOf: query.knownAsOf,
    validAt: query.validAt,
    records: resultRows,
    reasons: [...reasons].sort(),
  };
}
