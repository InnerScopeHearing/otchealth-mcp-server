import {
  assertionRecordSchema,
  evidencePackV1Schema,
  type AssertionRecord,
  type EvidencePackV1,
  type EvidenceReference,
} from './contracts.js';
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

export type RetrievalMatchFields = Readonly<{
  source?: unknown;
  id?: unknown;
  source_version?: unknown;
  path?: unknown;
  variants?: unknown;
}>;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

/**
 * Preserve actual search locators while making the missing assertion/authority boundary explicit.
 * Search metadata is intentionally labeled as an index hint, never an immutable source receipt.
 */
export function createRetrievalEvidencePack(input: Readonly<{
  hits: readonly unknown[];
  requestedTop: number;
  roomsSearched: readonly string[];
  roomsFailed: readonly string[];
  answer?: string;
  citations?: readonly unknown[];
  emptyReason?: 'search_unconfigured' | 'no_readable_rooms' | 'exact_id_not_checked' | 'exact_id_not_indexed' | 'exact_id_denied' | 'exact_id_unavailable' | 'search_unavailable';
}>): EvidencePackV1 {
  const hits = input.hits.slice(0, 100).map((value): RetrievalMatchFields => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as RetrievalMatchFields : {}
  ));
  const matches = hits.map((hit, index) => ({
    packLocatorId: `match-${index + 1}`,
    sourceRoom: boundedText(hit.source, 128),
    sourceRecordId: boundedText(typeof hit.id === 'string' || typeof hit.id === 'number' ? String(hit.id) : null, 1_024),
    indexedVersionHint: boundedText(hit.source_version, 1_024),
    pathHint: boundedText(hit.path, 2_000),
    alternatePathHints: Array.isArray(hit.variants)
      ? hit.variants.slice(0, 100).map((path) => boundedText(path, 2_000)).filter((path): path is string => path !== null)
      : [],
    authorityState: 'unknown' as const,
    currentnessState: 'unknown' as const,
  }));

  const answer = typeof input.answer === 'string' ? input.answer.trim().slice(0, 20_000) : '';
  const markerMatches = answer.matchAll(/\[(\d+)\]/g);
  const markerNumbers = [...markerMatches].map((match) => Number(match[1]));
  const citationRows = Array.isArray(input.citations) ? input.citations : [];
  const citationsByNumber = new Map<number, Record<string, unknown>>();
  let citationInvalid = false;
  for (const candidate of citationRows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      citationInvalid = true;
      continue;
    }
    const row = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(row.n) || Number(row.n) < 1 || Number(row.n) > hits.length || citationsByNumber.has(Number(row.n))) {
      citationInvalid = true;
      continue;
    }
    const hit = hits[Number(row.n) - 1];
    if (!hit || row.source !== hit.source || (row.id !== undefined && String(row.id) !== String(hit.id ?? ''))
      || (row.path !== undefined && row.path !== hit.path)
      || (row.source_version !== undefined && row.source_version !== hit.source_version)) {
      citationInvalid = true;
      continue;
    }
    citationsByNumber.set(Number(row.n), row);
  }
  const markerSyntaxInvalid = answer.includes('[') && (markerNumbers.length === 0 || /\[(?!\d+\])/.test(answer));
  const refs = markerNumbers.map((number) => matches[number - 1]?.packLocatorId)
    .filter((ref): ref is string => typeof ref === 'string');
  const allCitationsResolve = markerNumbers.length > 0
    && refs.length === markerNumbers.length
    && markerNumbers.every((number) => citationsByNumber.has(number));
  const citationInvalidFinal = Boolean(answer) && (citationInvalid || markerSyntaxInvalid || !allCitationsResolve);
  // A synthesized answer is an unsegmented text bundle, not a material-claim inventory.
  // Citation markers can be checked as retrieval metadata, but must not be promoted into
  // claim bindings or a fabricated denominator without typed claim/assertion segmentation.
  const claimBindings: EvidencePackV1['claimBindings'] = [];
  const roomsFailed = input.roomsFailed.filter((room) => boundedText(room, 128) !== null);
  const reason = input.emptyReason ?? (matches.length === 0 && roomsFailed.length > 0 ? 'search_unavailable' : 'no_matches');
  const noEvidence = matches.length === 0 && (reason === 'no_matches' || reason === 'exact_id_not_indexed');

  return evidencePackV1Schema.parse({
    schema: 'evidence-pack.v1',
    authorityState: 'unknown',
    sourceCurrentness: 'unknown',
    outcome: noEvidence ? 'no_evidence' : 'partial',
    reason: matches.length === 0 ? reason : 'untyped_search_hits',
    matches,
    claimBindings,
    citationAssessment: !answer ? 'not_applicable' : citationInvalidFinal ? 'invalid' : 'retrieval_only',
    conflictAssessment: 'not_assessed',
    calculationAssessment: 'not_evaluated',
    coverage: {
      requestedTop: Math.max(1, Math.min(25, Math.trunc(input.requestedTop) || 1)),
      expectedMatchCount: null,
      returnedMatchCount: matches.length,
      materialClaimCount: null,
      sourceBoundClaimCount: 0,
      unsupportedClaimCount: null,
      retrievalComplete: false,
      claimCoverage: 'not_assessed',
      roomsSearched: input.roomsSearched.filter((room) => boundedText(room, 128) !== null),
      roomsFailed,
    },
  });
}

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
