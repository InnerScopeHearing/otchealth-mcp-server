import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXHAUST_RECORD_TYPES,
  KNOWLEDGE_RECORD_TYPES,
  isExhaustType,
  buildExhaustFilterClause,
  demoteExhaustHits,
} from './room-hygiene.js';

// --- the lists themselves: no overlap, and the confirmed-real types are present ---

test('KNOWLEDGE and EXHAUST never overlap — a type is never both durable AND chatter', () => {
  for (const k of KNOWLEDGE_RECORD_TYPES) {
    assert.ok(!EXHAUST_RECORD_TYPES.includes(k), `"${k}" must not be in the exhaust list`);
  }
});

test('the exhaust list carries the CONFIRMED-live producers: status, compaction-digest, compaction-note', () => {
  // 'status' is auto-shared by mem.mjs on every `type === 'status'` write and indexed verbatim by
  // semantic.mjs; 'compaction-digest'/'compaction-note' are emitted by ledger-compaction/compact.mjs.
  for (const t of ['status', 'compaction-digest', 'compaction-note']) {
    assert.ok(EXHAUST_RECORD_TYPES.includes(t), `expected "${t}" in EXHAUST_RECORD_TYPES`);
  }
});

test('the 4 durable knowledge types match memory_remember\'s TYPES minus status', () => {
  assert.deepEqual([...KNOWLEDGE_RECORD_TYPES].sort(), ['correction', 'decision', 'fact', 'pitfall']);
});

// --- isExhaustType ---

test('isExhaustType: true for every listed exhaust type', () => {
  for (const t of EXHAUST_RECORD_TYPES) assert.equal(isExhaustType(t), true, t);
});

test('isExhaustType: false for a knowledge type', () => {
  for (const t of KNOWLEDGE_RECORD_TYPES) assert.equal(isExhaustType(t), false, t);
});

test('isExhaustType: false for undefined/null/non-string/unknown values (fail-open on garbage input)', () => {
  assert.equal(isExhaustType(undefined), false);
  assert.equal(isExhaustType(null), false);
  assert.equal(isExhaustType(42), false);
  assert.equal(isExhaustType(''), false);
  assert.equal(isExhaustType('entity'), false, 'entity (current-value tracking) is knowledge, not exhaust');
  assert.equal(isExhaustType('alias'), false);
});

// --- buildExhaustFilterClause ---

test('buildExhaustFilterClause: builds one `ne` per exhaust type, ANDed together, on the default field', () => {
  const clause = buildExhaustFilterClause();
  for (const t of EXHAUST_RECORD_TYPES) {
    assert.ok(clause.includes(`type ne '${t}'`), `clause should exclude "${t}": ${clause}`);
  }
  assert.equal(clause.split(' and ').length, EXHAUST_RECORD_TYPES.length);
});

test('buildExhaustFilterClause: honors a custom field name', () => {
  const clause = buildExhaustFilterClause('kind');
  assert.ok(clause.startsWith("kind ne 'status'"));
  assert.ok(!clause.includes('type ne'));
});

test('buildExhaustFilterClause: is pure — same input, same output, never throws', () => {
  assert.equal(buildExhaustFilterClause('type'), buildExhaustFilterClause('type'));
});

// --- demoteExhaustHits (2026-07-21: demote, never hard-delete) ---

test('demoteExhaustHits (a): an all-non-exhaust input is unchanged in order (and is the SAME array reference, no allocation)', () => {
  const hits = [
    { id: '1', type: 'fact', text: 'ASC key id is 9MR7PJHRYH' },
    { id: '2', type: 'decision', text: 'ship build 46' },
    { id: '3', type: 'pitfall', text: 'do not hardcode the ASC key' },
    { id: '4', type: 'correction', text: 'the key id was wrong, corrected here' },
  ];
  const result = demoteExhaustHits(hits, false);
  assert.deepEqual(result.map((h) => h.id), ['1', '2', '3', '4']);
  assert.equal(result, hits, 'no exhaust present -> same array reference (fast path)');
});

test('demoteExhaustHits (b): a mix reorders exhaust hits to the end WITHOUT dropping any, preserving each group\'s relative order', () => {
  const hits = [
    { id: '1', type: 'status', text: 'still working on X' },
    { id: '2', type: 'fact', text: 'ASC key id is 9MR7PJHRYH' },
    { id: '3', type: 'episode', text: 'auto-journaled tool call' },
    { id: '4', type: 'decision', text: 'ship build 46' },
    { id: '5', type: 'compaction-digest', text: '42 status rows between X and Y' },
    { id: '6', type: 'pitfall', text: 'do not hardcode the ASC key' },
  ];
  const result = demoteExhaustHits(hits, false);
  // non-exhaust (2, 4, 6) first in their original relative order, THEN exhaust (1, 3, 5) in
  // their original relative order -- nothing is dropped, count is unchanged.
  assert.deepEqual(result.map((h) => h.id), ['2', '4', '6', '1', '3', '5']);
  assert.equal(result.length, hits.length);
});

test('demoteExhaustHits (c): an all-exhaust input returns everything (nothing to demote against), order preserved', () => {
  const hits = [
    { id: '1', type: 'status', text: 'still working on X' },
    { id: '2', type: 'episode', text: 'auto-journaled tool call' },
    { id: '3', type: 'heartbeat', text: 'still alive' },
  ];
  const result = demoteExhaustHits(hits, false);
  assert.deepEqual(result.map((h) => h.id), ['1', '2', '3']);
});

test('demoteExhaustHits (d): top-N truncation prioritizes non-exhaust -- exhaust never crowds out a genuine hit that fits', () => {
  const hits = [
    { id: 'e1', type: 'status', text: 'chatter 1' },
    { id: 'n1', type: 'fact', text: 'fact 1' },
    { id: 'n2', type: 'decision', text: 'decision 1' },
    { id: 'e2', type: 'episode', text: 'chatter 2' },
    { id: 'n3', type: 'pitfall', text: 'pitfall 1' },
  ];
  // 3 non-exhaust hits exist; asking for top 2 must return ONLY genuine hits, never an exhaust one.
  const top2 = demoteExhaustHits(hits, false, 2);
  assert.deepEqual(top2.map((h) => h.id), ['n1', 'n2']);

  // Asking for top 4 (more than the 3 genuine hits available) backfills with exhaust to reach the
  // requested count, rather than returning a truncated 3-hit result.
  const top4 = demoteExhaustHits(hits, false, 4);
  assert.deepEqual(top4.map((h) => h.id), ['n1', 'n2', 'n3', 'e1']);

  // Asking for more than the total hit count returns everything, genuine-first, nothing invented.
  const top10 = demoteExhaustHits(hits, false, 10);
  assert.deepEqual(top10.map((h) => h.id), ['n1', 'n2', 'n3', 'e1', 'e2']);
});

test('demoteExhaustHits (e): includeOps=true is a full-inclusion no-op -- input order preserved, no demotion, same array reference when no limit is given', () => {
  const hits = [
    { id: '1', type: 'status', text: 'chatter' },
    { id: '2', type: 'fact', text: 'a fact' },
    { id: '3', type: 'episode', text: 'more chatter' },
  ];
  const result = demoteExhaustHits(hits, true);
  assert.deepEqual(result.map((h) => h.id), ['1', '2', '3'], 'order must be untouched, nothing demoted');
  assert.equal(result, hits, 'must return the SAME array reference when includeOps is true and no limit is given');
});

test('demoteExhaustHits: includeOps=true still respects an explicit limit (truncation, not demotion)', () => {
  const hits = [
    { id: '1', type: 'status', text: 'chatter' },
    { id: '2', type: 'fact', text: 'a fact' },
    { id: '3', type: 'episode', text: 'more chatter' },
  ];
  const result = demoteExhaustHits(hits, true, 2);
  assert.deepEqual(result.map((h) => h.id), ['1', '2'], 'plain truncation, original order, no reordering');
});

test('demoteExhaustHits (f): empty input returns empty and never throws, for both includeOps values and with/without a limit', () => {
  assert.deepEqual(demoteExhaustHits([], false), []);
  assert.deepEqual(demoteExhaustHits([], true), []);
  assert.deepEqual(demoteExhaustHits([], false, 5), []);
  assert.deepEqual(demoteExhaustHits([], true, 5), []);
});

test('demoteExhaustHits (g): a hit with no `type` field at all (doc-indexer profile rooms) is treated as non-exhaust, never demoted', () => {
  const hits = [
    { id: 'a', text: 'a doc-indexer chunk with no type field at all' },
    { id: 'b', type: 'status', text: 'chatter' },
    { id: 'c', text: 'another chunk with no type field' },
  ];
  const result = demoteExhaustHits(hits, false);
  assert.deepEqual(result.map((h) => h.id), ['a', 'c', 'b'], 'both no-type hits stay ahead of the status hit');
});

test('demoteExhaustHits: is pure -- same input, same output, never mutates the input array', () => {
  const hits = [
    { id: '1', type: 'status', text: 'chatter' },
    { id: '2', type: 'fact', text: 'a fact' },
  ];
  const before = [...hits];
  demoteExhaustHits(hits, false, 1);
  assert.deepEqual(hits, before, 'the input array must not be mutated');
});
