import { createHash } from 'node:crypto';

/**
 * Pure, bounded projection of the pinned finance catalogue used by the graph
 * source bridge.  This deliberately has no S3, Fastify, or broker dependency
 * so route code can obtain a page without widening its authority.
 */
export const GRAPH_CATALOG_SOURCE_VERSION = 'catalog-mention-snapshot-v1';
const ROOM = 'finance';
const SOURCE_INDEX = 'finance-cfo-source-docs';
const SHA = /^[a-f0-9]{64}$/;
const FIELDS = [
  'path', 'sha256', 'sidecar', 'enriched', 'enriched_sha256', 'err', 'doc_date',
  'entity', 'entities', 'named_entities_orgs', 'named_entities_people', 'signatories',
  'counterparty',
] as const;
const VALIDATION_TIME = '2000-01-01T00:00:00.000Z';

export type FinanceCatalogRow = Readonly<Record<string, unknown>>;
export type GraphCatalogCursor = Readonly<{
  room: 'finance';
  catalog_source_sha256: string;
  catalog_etag_sha256: string;
  after_document_id: string;
}>;

export type GraphCatalogPlannerInput = Readonly<{
  rows: readonly FinanceCatalogRow[];
  catalogEtag: string;
  catalogSourceSha256: string;
  createdAt: string;
  cursor?: GraphCatalogCursor | null;
  limit?: number;
}>;

type Document = Readonly<{
  room: 'finance';
  document_version_id: string;
  source_version: string;
  source_path_hash: string;
  enrichment_row_sha256: string;
  extractor_version: typeof GRAPH_CATALOG_SOURCE_VERSION;
  retract_event_ids: readonly string[];
}>;
type Manifest = Readonly<{
  version: 'graph-backfill-runner-v1';
  created_at: string;
  documents: readonly (Document & Readonly<{ ordinal: number }>)[];
  manifest_sha256: string;
}>;

export type GraphCatalogPlan = Readonly<{
  catalog: Readonly<{
    room: 'finance';
    sourceIndex: 'finance-cfo-source-docs';
    catalogSourceSha256: string;
    catalogEtag: string;
    createdAt: string;
  }>;
  page: Readonly<{
    done: boolean;
    manifest: Manifest | null;
    rows: readonly FinanceCatalogRow[];
    counts: Readonly<{ catalog_rows: number; eligible: number; excluded: number; published: number }>;
    next_cursor: GraphCatalogCursor | null;
  }>;
  cursor_reset: boolean;
}>;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
function cloned(value: unknown): unknown {
  return structuredClone(value);
}
function selected(row: FinanceCatalogRow): FinanceCatalogRow {
  const result: Record<string, unknown> = {};
  for (const field of FIELDS) if (Object.hasOwn(row, field)) result[field] = cloned(row[field]);
  if (Buffer.byteLength(canonical(result)) > 65536) fail('source_row_too_large');
  return result;
}
function projectionInputSha256(row: FinanceCatalogRow): string {
  return hash(canonical({
    path: row.path,
    sha256: row.sha256,
    sidecar: row.sidecar,
    enriched: row.enriched,
    enriched_sha256: row.enriched_sha256,
    err: row.err ?? null,
    doc_date: row.doc_date ?? null,
    entity: row.entity ?? null,
    entities: row.entities ?? null,
    named_entities_orgs: row.named_entities_orgs ?? null,
    named_entities_people: row.named_entities_people ?? null,
    signatories: row.signatories ?? null,
    counterparty: row.counterparty ?? null,
  }));
}
function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') ||
      value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value) ||
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const segments = value.split('/');
  const reserved = new Set(['_text', '_catalog', '_review', '_memory', '_state', '_archive']);
  return segments.every((part) => part.length > 0 && part !== '.' && part !== '..') &&
    !reserved.has((segments[0] ?? '').toLowerCase());
}
function eligible(row: FinanceCatalogRow): boolean {
  return safeRelativePath(row.path) && typeof row.sha256 === 'string' && SHA.test(row.sha256) &&
    row.sidecar === true && row.enriched === true && row.enriched_sha256 === row.sha256 &&
    !row.err;
}
function documentVersion(row: FinanceCatalogRow): Pick<Document, 'document_version_id'|'source_version'|'source_path_hash'> {
  const path = row.path as string;
  const sourceVersion = row.sha256 as string;
  const sourcePathHash = hash(path);
  return {
    document_version_id: `docv_${hash(`graph-assertion-v2\0${canonical({
      authority: { source_room: ROOM, source_index: SOURCE_INDEX, policy_ref: 'gateway:isLaneAllowed' },
      source_path_hash: sourcePathHash,
      source_version: sourceVersion,
    })}`)}`,
    source_version: sourceVersion,
    source_path_hash: sourcePathHash,
  };
}
function frozenManifest(documents: readonly Document[], createdAt: string): Manifest {
  const numbered = documents.map((document, ordinal) => ({ ordinal, ...document }));
  const unsigned = { version: 'graph-backfill-runner-v1' as const, created_at: createdAt, documents: numbered };
  return { ...unsigned, manifest_sha256: hash(canonical(unsigned)) };
}

/** Mirrors source-bridge planCatalogPage with a route-shaped, finance-only result. */
export function planGraphCatalogPage(input: GraphCatalogPlannerInput): GraphCatalogPlan {
  const { rows, catalogEtag, catalogSourceSha256, createdAt, limit = 1 } = input;
  if (!Array.isArray(rows) || rows.length > 100000 || typeof catalogEtag !== 'string' || !catalogEtag ||
      !SHA.test(catalogSourceSha256) || typeof createdAt !== 'string' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('catalog_page_shape');

  const etagHash = hash(catalogEtag);
  let prior = '';
  let cursorReset = false;
  if (input.cursor) {
    if (Object.keys(input.cursor).sort().join(',') !== ['room','catalog_source_sha256','catalog_etag_sha256','after_document_id'].sort().join(',') ||
        input.cursor.room !== ROOM || input.cursor.catalog_source_sha256 !== catalogSourceSha256 ||
        !SHA.test(input.cursor.catalog_etag_sha256) || !/^docv_[a-f0-9]{64}$/.test(input.cursor.after_document_id)) fail('catalog_cursor_stale');
    if (input.cursor.room === ROOM && input.cursor.catalog_source_sha256 === catalogSourceSha256 &&
        input.cursor.catalog_etag_sha256 === etagHash && typeof input.cursor.after_document_id === 'string') {
      prior = input.cursor.after_document_id;
    } else {
      cursorReset = true;
    }
  }

  const docs = new Map<string, { document: Pick<Document, 'document_version_id'|'source_version'|'source_path_hash'>; row: FinanceCatalogRow }>();
  let excluded = 0;
  for (const row of rows) {
    if (!eligible(row)) { excluded++; continue; }
    const snapshot = selected(row);
    const document = documentVersion(snapshot);
    const existing = docs.get(document.document_version_id);
    if (existing && canonical(existing.row) !== canonical(snapshot)) fail('catalog_duplicate_conflict');
    docs.set(document.document_version_id, { document, row: snapshot });
  }
  const ordered = [...docs.values()].sort((a, b) => a.document.document_version_id.localeCompare(b.document.document_version_id));
  const chosen = ordered.filter((item) => item.document.document_version_id > prior).slice(0, limit);
  const catalog = Object.freeze({ room: ROOM, sourceIndex: SOURCE_INDEX, catalogSourceSha256, catalogEtag, createdAt });
  if (!chosen.length) return Object.freeze({ catalog, cursor_reset: cursorReset, page: Object.freeze({
    done: true, manifest: null, rows: [],
    counts: Object.freeze({ catalog_rows: rows.length, eligible: ordered.length, excluded, published: 0 }), next_cursor: null,
  }) });

  const documents: Document[] = chosen.map(({ document, row }) => ({
    room: ROOM, ...document, enrichment_row_sha256: projectionInputSha256(row),
    extractor_version: GRAPH_CATALOG_SOURCE_VERSION, retract_event_ids: [],
  }));
  const manifest = frozenManifest(documents, createdAt);
  const last = documents.at(-1)?.document_version_id;
  if (!last) fail('catalog_page_shape');
  const nextCursor: GraphCatalogCursor = { room: ROOM, catalog_source_sha256: catalogSourceSha256,
    catalog_etag_sha256: etagHash, after_document_id: last };
  return Object.freeze({ catalog, cursor_reset: cursorReset, page: Object.freeze({
    done: ordered.at(-1)?.document.document_version_id === last,
    manifest, rows: chosen.map((item) => item.row),
    counts: Object.freeze({ catalog_rows: rows.length, eligible: ordered.length, excluded, published: documents.length }),
    next_cursor: nextCursor,
  }) });
}

export const graphCatalogPlannerInternals = Object.freeze({ canonical, documentVersion, frozenManifest, hash, projectionInputSha256, selected, VALIDATION_TIME });

