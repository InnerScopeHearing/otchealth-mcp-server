import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXHAUST_RECORD_TYPES,
  KNOWLEDGE_RECORD_TYPES,
  isExhaustType,
  buildExhaustFilterClause,
  filterExhaustHits,
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

// --- filterExhaustHits ---

test('filterExhaustHits: drops exhaust-typed hits by default (includeOps=false)', () => {
  const hits = [
    { id: '1', type: 'fact', text: 'ASC key id is 9MR7PJHRYH' },
    { id: '2', type: 'status', text: 'still working on the PlantID backend' },
    { id: '3', type: 'decision', text: 'ship build 46' },
    { id: '4', type: 'compaction-digest', text: '42 status rows between X and Y' },
  ];
  const result = filterExhaustHits(hits, false);
  assert.deepEqual(result.map((h) => h.id), ['1', '3']);
});

test('filterExhaustHits: includeOps=true is a true no-op (same array reference, nothing dropped)', () => {
  const hits = [
    { id: '1', type: 'status', text: 'chatter' },
    { id: '2', type: 'fact', text: 'a fact' },
  ];
  const result = filterExhaustHits(hits, true);
  assert.equal(result, hits, 'must return the SAME array reference when includeOps is true');
});

test('filterExhaustHits: a hit with no `type` field is never dropped (rooms with no type field are untouched)', () => {
  const hits = [{ id: 'a', text: 'a doc-indexer chunk with no type field at all' }, { id: 'b', type: 'status', text: 'chatter' }];
  const result = filterExhaustHits(hits, false);
  assert.deepEqual(result.map((h) => h.id), ['a']);
});

test('filterExhaustHits: returns the SAME array reference when nothing would be dropped (fast path, no allocation)', () => {
  const hits = [{ id: '1', type: 'fact' }, { id: '2', type: 'decision' }];
  const result = filterExhaustHits(hits, false);
  assert.equal(result, hits);
});

test('filterExhaustHits: empty input never throws', () => {
  assert.deepEqual(filterExhaustHits([], false), []);
  assert.deepEqual(filterExhaustHits([], true), []);
});
