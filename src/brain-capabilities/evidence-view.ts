import { assertionRecordSchema, type AssertionRecord, type EvidenceReference } from './contracts.js';
import { z } from 'zod';

export type EvidenceViewContext = Readonly<{ actorId: string; tenantId: string }>;
export type TrustedAuthorization = (input: Readonly<{
  context: EvidenceViewContext;
  assertion: AssertionRecord;
  evidence?: EvidenceReference;
}>) => boolean;

export type EvidenceViewQuery = Readonly<{
  mode: 'current' | 'valid-at' | 'known-as-of';
  /** Business-time point. Endpoints are exclusive: start <= point < end. */
  validAt: string;
  /** Trusted runtime observation time. This component never reads Date.now(). */
  observedAt: string;
  /** Required only for known-as-of; recorded end is also exclusive. */
  knownAsOf?: string;
}>;

export type EvidenceBackedBrief = Readonly<{
  assertionId: string;
  status: AssertionRecord['status'];
  lifecycle: AssertionRecord['lifecycle'];
  statement: string;
  validTime: AssertionRecord['validTime'];
  recordedAt: string;
  recordedUntil: string | null;
  evidence: readonly EvidenceReference[];
}>;

function timeValue(value: unknown): number | null {
  const timestamp = z.string().datetime({ offset: true }).safeParse(value);
  if (!timestamp.success) return null;
  const parsed = Date.parse(timestamp.data);
  return Number.isFinite(parsed) ? parsed : null;
}

function contains(interval: AssertionRecord['validTime'], point: number): boolean {
  if (interval.basis !== 'exact') return false;
  const start = interval.start === null ? null : timeValue(interval.start);
  const end = interval.end === null ? null : timeValue(interval.end);
  return (start === null || start <= point) && (end === null || point < end);
}

function isKnownAt(assertion: AssertionRecord, point: number): boolean {
  const recordedAt = timeValue(assertion.recordedAt);
  const recordedUntil = assertion.recordedUntil === null ? null : timeValue(assertion.recordedUntil);
  return recordedAt !== null && recordedAt <= point && (recordedUntil === null || point < recordedUntil);
}

function authorized(
  authorize: TrustedAuthorization,
  context: EvidenceViewContext,
  assertion: AssertionRecord,
  evidence?: EvidenceReference,
): boolean {
  try {
    return authorize({ context, assertion, evidence }) === true;
  } catch {
    return false;
  }
}

/**
 * Returns only fully authorized, temporally applicable assertions. Validation is structural only;
 * the runtime authorization callback remains the authority for access decisions. No result metadata
 * reveals whether an omitted record was invalid, denied, stale, or absent.
 */
export function selectEvidenceBackedAssertions(
  records: readonly unknown[],
  context: EvidenceViewContext,
  query: EvidenceViewQuery,
  authorize: TrustedAuthorization,
): AssertionRecord[] {
  // This guard intentionally remains at runtime: external MCP input can bypass TypeScript types.
  if (!Array.isArray(records)) return [];
  if (!context || typeof context.actorId !== 'string' || typeof context.tenantId !== 'string'
    || !context.actorId.trim() || !context.tenantId.trim()) return [];
  if (!query || typeof query !== 'object' || !['current', 'valid-at', 'known-as-of'].includes(query.mode)) return [];
  const validAt = timeValue(query.validAt);
  const observedAt = timeValue(query.observedAt);
  const knownAsOf = query.mode === 'known-as-of' && query.knownAsOf ? timeValue(query.knownAsOf) : null;
  if (validAt === null || observedAt === null || (query.mode === 'known-as-of' && knownAsOf === null)) return [];
  if (query.mode === 'current' && validAt !== observedAt) return [];
  if (knownAsOf !== null && knownAsOf > observedAt) return [];

  const selected: AssertionRecord[] = [];
  for (const candidate of records) {
    const parsed = assertionRecordSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const assertion = parsed.data;
    if (assertion.tenantId !== context.tenantId) continue;
    // A historical query deliberately retains lifecycle state. Current and valid-at views are
    // current knowledge views, therefore only active records known at observedAt may appear.
    if (query.mode !== 'known-as-of' && assertion.lifecycle !== 'active') continue;
    if (!contains(assertion.validTime, validAt)) continue;
    if (query.mode === 'known-as-of') {
      if (knownAsOf === null || !isKnownAt(assertion, knownAsOf)) continue;
    } else if (!isKnownAt(assertion, observedAt)) {
      continue;
    }
    if (!authorized(authorize, context, assertion)) continue;

    // All supporting evidence must be both tenant-safe and individually authorized. Never aggregate
    // a partially visible premise into a decision brief.
    if (assertion.evidence.some((evidence) => (
      evidence.tenantId !== context.tenantId || !authorized(authorize, context, assertion, evidence)
    ))) continue;
    selected.push(assertion);
  }
  return selected;
}

/** A structured brief can only be created through the same authorization and temporal selection path. */
export function createEvidenceBackedDecisionBrief(
  records: readonly unknown[],
  context: EvidenceViewContext,
  query: EvidenceViewQuery,
  authorize: TrustedAuthorization,
): EvidenceBackedBrief[] {
  return selectEvidenceBackedAssertions(records, context, query, authorize).map((assertion) => ({
    assertionId: assertion.assertionId,
    status: assertion.status,
    lifecycle: assertion.lifecycle,
    statement: assertion.statement,
    validTime: assertion.validTime,
    recordedAt: assertion.recordedAt,
    recordedUntil: assertion.recordedUntil,
    evidence: assertion.evidence,
  }));
}
