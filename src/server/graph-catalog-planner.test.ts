import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { graphCatalogPlannerInternals, planGraphCatalogPage } from './graph-catalog-planner.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = 'a'.repeat(64);
const row = (path: string, extra: Record<string, unknown> = {}) => ({
  path, sha256: sha(path), sidecar: true, enriched: true, enriched_sha256: sha(path), entity: 'OTCHealth',
  ignored_content: 'must never leave the catalogue projection', ...extra,
});

test('plans a bounded metadata-only finance page with source bridge document ids', () => {
  const inputRows = [row('z.txt'), row('a.txt'), row('failed.txt', { err: 'source error' })];
  const plan = planGraphCatalogPage({ rows: inputRows, catalogEtag: 'etag-1', catalogSourceSha256: source,
    createdAt: '2026-09-08T00:00:00.000Z', limit: 1 });
  assert.deepEqual(plan.catalog, { room: 'finance', sourceIndex: 'finance-cfo-source-docs', catalogSourceSha256: source,
    catalogEtag: 'etag-1', createdAt: '2026-09-08T00:00:00.000Z' });
  assert.equal(plan.page.rows.length, 1);
  assert.equal('ignored_content' in plan.page.rows[0]!, false);
  assert.deepEqual(plan.page.counts, { catalog_rows: 3, eligible: 2, excluded: 1, published: 1 });
  const doc = plan.page.manifest?.documents[0];
  assert.ok(doc);
  const expected = `docv_${sha(`graph-assertion-v2\0${graphCatalogPlannerInternals.canonical({
    authority: { source_room: 'finance', source_index: 'finance-cfo-source-docs', policy_ref: 'gateway:isLaneAllowed' },
    source_path_hash: sha(plan.page.rows[0]!.path as string), source_version: plan.page.rows[0]!.sha256,
  })}`)}`;
  assert.equal(doc?.document_version_id, expected);
  assert.equal(doc?.enrichment_row_sha256, graphCatalogPlannerInternals.projectionInputSha256(plan.page.rows[0]!));
  assert.equal(doc?.extractor_version, 'catalog-mention-snapshot-v1');
});

test('continues from a matching cursor and resets stale cursor state', () => {
  const base = { rows: [row('one.txt'), row('two.txt')], catalogEtag: 'etag-1', catalogSourceSha256: source,
    createdAt: '2026-09-08T00:00:00.000Z', limit: 1 } as const;
  const first = planGraphCatalogPage(base);
  const second = planGraphCatalogPage({ ...base, cursor: first.page.next_cursor });
  assert.equal(second.cursor_reset, false);
  assert.notEqual(second.page.next_cursor?.after_document_id, first.page.next_cursor?.after_document_id);
  const reset = planGraphCatalogPage({ ...base, cursor: { ...first.page.next_cursor!, catalog_etag_sha256: 'b'.repeat(64) } });
  assert.equal(reset.cursor_reset, true);
  assert.equal(reset.page.next_cursor?.after_document_id, first.page.next_cursor?.after_document_id);
});

test('rejects invalid bounds and conflicting document versions', () => {
  assert.throws(() => planGraphCatalogPage({ rows: [], catalogEtag: 'etag', catalogSourceSha256: source,
    createdAt: '2026-09-08T00:00:00.000Z', limit: 11 }), { message: 'catalog_page_shape' });
  const duplicate = row('same.txt');
  assert.throws(() => planGraphCatalogPage({ rows: [duplicate, { ...duplicate, entity: 'different' }], catalogEtag: 'etag',
    catalogSourceSha256: source, createdAt: '2026-09-08T00:00:00.000Z' }), { message: 'catalog_duplicate_conflict' });
});
