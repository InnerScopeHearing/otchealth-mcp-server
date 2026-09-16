/**
 * Content-safe canonical source receipts for managed GraphRAG citations.
 *
 * A GraphRAG hit is not a source authority. This resolver accepts only an
 * operator-published mapping keyed by the canonical source id and immutable
 * version. It returns hashes and ring information only: never a source URI,
 * filename, document text, S3 key, or arbitrary provider metadata.
 */
import { createHash } from 'node:crypto';
import { isLaneAllowed } from './search-privileged.js';

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^sha256:[a-f0-9]{64}$/;
const GROUPS = new Set(['company', 'company_shared']);
export type CitationSourceGroup = 'company' | 'company_shared';

export type GraphCitationMapping = Readonly<{
  canonical_id: string;
  source_version: string;
  source_group: CitationSourceGroup;
  source_sha256: string;
  source_locator_sha256: string;
  provenance_receipt_sha256: string;
}>;

export type GraphCitationReceipt = Readonly<{
  schema: 'graph-citation-source-resolution-receipt-v1';
  receipt_id: string;
  canonical_id: string;
  source_version: string;
  source_group: CitationSourceGroup;
  source_sha256: string;
  source_locator_sha256: string;
  provenance_receipt_sha256: string;
}>;

export type ReceiptResolution =
  | Readonly<{ status: 'resolved'; receipt: GraphCitationReceipt }>
  | Readonly<{ status: 'forbidden_ring' | 'stale_source_version' | 'source_mapping_not_found' }>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value as object).sort().map(key =>
    JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function validMapping(value: unknown): value is GraphCitationMapping {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join('\0') === ['canonical_id', 'provenance_receipt_sha256', 'source_group', 'source_locator_sha256', 'source_sha256', 'source_version'].join('\0') &&
    typeof item.canonical_id === 'string' && HASH.test(item.canonical_id) &&
    typeof item.source_version === 'string' && VERSION.test(item.source_version) &&
    typeof item.source_group === 'string' && GROUPS.has(item.source_group) &&
    typeof item.source_sha256 === 'string' && HASH.test(item.source_sha256) &&
    typeof item.source_locator_sha256 === 'string' && HASH.test(item.source_locator_sha256) &&
    typeof item.provenance_receipt_sha256 === 'string' && HASH.test(item.provenance_receipt_sha256) &&
    item.source_version === `sha256:${item.source_sha256}`;
}

function allowed(caller: string, group: CitationSourceGroup): boolean {
  // Keep the same coarse-company gate as GraphRAG retrieval. The CTO is
  // intentionally limited to the separately materialized shared projection.
  if (group === 'company_shared') return caller === 'cto';
  return isLaneAllowed('finance-cfo-source-docs', caller) && isLaneAllowed('legal-company', caller);
}

/**
 * Builds a fail-closed resolver from an authenticated, content-free mapping.
 * Invalid, duplicate, or inconsistent entries make the whole mapping unusable
 * rather than allowing an ambiguous citation to resolve.
 */
export function createGraphCitationReceiptResolver(mappings: readonly unknown[]) {
  const valid = Array.isArray(mappings) && mappings.length <= 100_000 && mappings.every(validMapping);
  const byKey = new Map<string, GraphCitationMapping>();
  const versions = new Map<string, Set<string>>();
  if (valid) for (const mapping of mappings as readonly GraphCitationMapping[]) {
    const key = `${mapping.canonical_id}\0${mapping.source_version}`;
    if (byKey.has(key)) return () => ({ status: 'source_mapping_not_found' } as const);
    byKey.set(key, mapping);
    const found = versions.get(mapping.canonical_id) ?? new Set<string>();
    found.add(mapping.source_version); versions.set(mapping.canonical_id, found);
  }
  return (request: { caller_agent: string; canonical_id: string; source_version: string }): ReceiptResolution => {
    if (!valid || !HASH.test(request.canonical_id) || !VERSION.test(request.source_version)) return { status: 'source_mapping_not_found' };
    const mapping = byKey.get(`${request.canonical_id}\0${request.source_version}`);
    if (!mapping) return versions.has(request.canonical_id) ? { status: 'stale_source_version' } : { status: 'source_mapping_not_found' };
    if (!allowed(request.caller_agent, mapping.source_group)) return { status: 'forbidden_ring' };
    const source = {
      canonical_id: mapping.canonical_id, source_version: mapping.source_version, source_group: mapping.source_group,
      source_sha256: mapping.source_sha256, source_locator_sha256: mapping.source_locator_sha256,
      provenance_receipt_sha256: mapping.provenance_receipt_sha256,
    };
    return { status: 'resolved', receipt: Object.freeze({ schema: 'graph-citation-source-resolution-receipt-v1', receipt_id: 'gcr_' + hash(canonical(source)), ...source }) };
  };
}
