import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rrfFuse } from './rrf.js';

// Relocated verbatim from tools/kb/brain-search.test.ts (2026-07-15) when rrfFuse itself moved here
// — see rrf.ts's file header for why. brain-search.ts re-exports rrfFuse, so its own callers and
// import sites are unaffected; these tests just now live next to the function they test.

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

test('rrfFuse: the SAME room label appearing twice contributes two independent ranked lists (deep-retrieval\'s intra-room-across-subqueries use case)', () => {
  const fused = rrfFuse(
    [
      { room: 'memory-exec', hits: [{ text: 'sq0-top', id: 'doc1' }] },
      { room: 'memory-exec', hits: [{ text: 'sq1-top', id: 'doc2' }] },
    ],
    5,
  );
  assert.equal(fused.length, 2, 'both lists contribute, even though they share a room label');
  for (const h of fused) assert.equal(h.source, 'memory-exec');
});

test('rrfFuse does not dedupe by id — a caller that needs one row per document must dedupe itself', () => {
  const fused = rrfFuse(
    [
      { room: 'memory-exec', hits: [{ text: 'same doc', id: 'doc1' }] },
      { room: 'memory-exec', hits: [{ text: 'same doc', id: 'doc1' }] },
    ],
    5,
  );
  assert.equal(fused.length, 2, 'rrfFuse itself is a flatten+rank operation, not an id-aware merge');
});
