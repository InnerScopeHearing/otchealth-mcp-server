import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHistoryCandidates, validCandidatePagination } from './candidate-query-pagination.js';

for (const size of [0, 101, 201, 400]) test(`all ${size} candidates remain reachable across resolver pages`, async () => {
  const source = Array.from({ length: size }, (_, record_id) => ({ record_id }));
  const offsets: number[] = [];
  const actual = await collectHistoryCandidates(async offset => {
    offsets.push(offset);
    return { items: source.slice(offset, offset + 100), total: size, next_offset: offset + 100 < size ? offset + 100 : null };
  });
  assert.deepEqual(actual, source);
  assert.equal(new Set(actual.map(x => x.record_id)).size, size);
  assert.ok(offsets.length <= 4);
});

test('invalid original pagination is rejected before overrides', () => {
  for (const offset of [-1, 0.5, '1', 102401]) assert.equal(validCandidatePagination({ offset }), false);
  for (const limit of [-1, 0, 0.5, '1', 101]) assert.equal(validCandidatePagination({ limit }), false);
  assert.equal(validCandidatePagination({ offset: 1000, limit: 100 }), true);
});

test('inconsistent or truncated resolver pagination cannot silently lose records', async () => {
  await assert.rejects(collectHistoryCandidates(async () => ({ items: [1], total: 2, next_offset: null })), /inconsistent/);
  await assert.rejects(collectHistoryCandidates(async () => ({ items: [], total: 2, next_offset: 0 })), /inconsistent/);
});
