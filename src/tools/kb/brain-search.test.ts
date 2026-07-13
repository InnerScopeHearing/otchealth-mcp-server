import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomsFor, rrfFuse, OPEN_ROOMS, RING_ROOMS } from './brain-search.js';

// --- ring safety: federation must NEVER become a side door around a privilege boundary ---

test('a non-ring caller (cto) gets ONLY the open rooms — no finance, no legal', () => {
  const rooms = roomsFor('cto');
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
  for (const r of RING_ROOMS) assert.ok(!rooms.includes(r), `cto must not reach ${r}`);
});

test('an unauthenticated caller still gets the open rooms, never the ring', () => {
  const rooms = roomsFor(undefined);
  assert.deepEqual(rooms, [...OPEN_ROOMS]);
});

test('an EXEC_RING caller (cfo) reaches the ring rooms too', () => {
  const rooms = roomsFor('cfo');
  assert.ok(rooms.includes('finance-cfo-source-docs'));
  assert.ok(rooms.includes('legal-company'));
  assert.ok(rooms.includes('memory-exec'));
});

test('a domain filter cannot escalate: cto asking for finance gets NO finance rooms', () => {
  assert.deepEqual(roomsFor('cto', 'finance'), []);
});

test('domain filter narrows correctly for a permitted caller', () => {
  assert.deepEqual(roomsFor('cfo', 'legal').sort(), ['legal-company', 'legal-personal', 'legal-personal-memory']);
  assert.deepEqual(roomsFor('cto', 'exec'), ['memory-exec']);
});

test('an unknown domain returns all permitted rooms rather than silently nothing', () => {
  assert.deepEqual(roomsFor('cto', 'not-a-domain'), [...OPEN_ROOMS]);
});

// --- RRF: scores across indexes are NOT comparable; fusion must go by RANK ---

test('rrfFuse ranks by position, not by raw score (scale-free across indexes)', () => {
  // roomB's raw scores are 100x roomA's. A naive score sort would let roomB dominate entirely.
  const fused = rrfFuse(
    [
      { room: 'a', hits: [{ score: 1, text: 'a1' }, { score: 0.9, text: 'a2' }] },
      { room: 'b', hits: [{ score: 900, text: 'b1' }, { score: 800, text: 'b2' }] },
    ],
    4,
  );
  // rank-1 hits from BOTH rooms must outrank the rank-2 hits from either.
  const top2 = fused.slice(0, 2).map((h) => h.text).sort();
  assert.deepEqual(top2, ['a1', 'b1'], 'both rank-1 hits should surface above any rank-2 hit');
});

test('rrfFuse tags every hit with its source room and respects top', () => {
  const fused = rrfFuse(
    [
      { room: 'memory-exec', hits: [{ text: 'x' }, { text: 'y' }] },
      { room: 'commons-company-journal', hits: [{ text: 'z' }] },
    ],
    2,
  );
  assert.equal(fused.length, 2);
  for (const h of fused) assert.ok(h.source.length > 0, 'every hit must name its source room');
});

test('rrfFuse survives an empty room without throwing', () => {
  const fused = rrfFuse([{ room: 'a', hits: [] }, { room: 'b', hits: [{ text: 'b1' }] }], 5);
  assert.deepEqual(fused.map((h) => h.text), ['b1']);
});
