import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphCitationReceiptResolver } from './graph-citation-receipts.js';

const id = 'a'.repeat(64), source = 'b'.repeat(64);
const mapping = Object.freeze({ canonical_id: id, source_version: `sha256:${source}`, source_group: 'company' as const,
  source_sha256: source, source_locator_sha256: 'c'.repeat(64), provenance_receipt_sha256: 'd'.repeat(64) });

test('resolves an authorized canonical source ID and immutable version without source content', () => {
  const result = createGraphCitationReceiptResolver([mapping])({ caller_agent: 'cfo', canonical_id: id, source_version: mapping.source_version });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.deepEqual(Object.keys(result.receipt).sort(), ['canonical_id', 'provenance_receipt_sha256', 'receipt_id', 'schema', 'source_group', 'source_locator_sha256', 'source_sha256', 'source_version']);
  assert.match(result.receipt.receipt_id, /^gcr_[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('s3://'), false);
  assert.equal(JSON.stringify(result).includes('text'), false);
});

test('rejects a stale version for a known canonical source', () => {
  const result = createGraphCitationReceiptResolver([mapping])({ caller_agent: 'cfo', canonical_id: id, source_version: 'sha256:' + 'e'.repeat(64) });
  assert.deepEqual(result, { status: 'stale_source_version' });
});

test('denies a mapping outside the caller ring before returning a receipt', () => {
  const result = createGraphCitationReceiptResolver([mapping])({ caller_agent: 'cto', canonical_id: id, source_version: mapping.source_version });
  assert.deepEqual(result, { status: 'forbidden_ring' });
});

test('does not resolve an absent canonical source mapping', () => {
  const result = createGraphCitationReceiptResolver([mapping])({ caller_agent: 'cfo', canonical_id: 'e'.repeat(64), source_version: mapping.source_version });
  assert.deepEqual(result, { status: 'source_mapping_not_found' });
});
