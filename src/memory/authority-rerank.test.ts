import { test } from 'node:test';
import assert from 'node:assert';
import {
  rerankEnabled,
  authorityMultiplier,
  sourceMultiplier,
  freshnessMultiplier,
  adjustedScore,
  rerankByAuthority,
  type Rerankable,
} from './authority-rerank.js';

const NOW = Date.parse('2026-07-17T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// ── multipliers ──────────────────────────────────────────────────────────────────────────────────

test('authority: decision/correction outrank fact outrank status/episode; unknown is neutral', () => {
  assert.ok(authorityMultiplier('decision') > authorityMultiplier('fact'));
  assert.ok(authorityMultiplier('correction') > authorityMultiplier('fact'));
  assert.ok(authorityMultiplier('fact') > authorityMultiplier('status'));
  assert.ok(authorityMultiplier('status') > authorityMultiplier('episode'));
  assert.equal(authorityMultiplier(undefined), 1.0);
  assert.equal(authorityMultiplier('somethingelse'), 1.0);
  assert.equal(authorityMultiplier('DECISION'), authorityMultiplier('decision')); // case-insensitive
});

test('source: Matt boosts, automated capture demotes, exec lane mild boost, else neutral', () => {
  assert.ok(sourceMultiplier('Matt 2026-06-20', undefined) > 1);
  assert.ok(sourceMultiplier(undefined, 'matt') > 1);
  assert.ok(sourceMultiplier('auto-journal tool call', undefined) < 1);
  assert.ok(sourceMultiplier(undefined, 'cto') > 1 && sourceMultiplier(undefined, 'cto') < sourceMultiplier(undefined, 'matt'));
  assert.equal(sourceMultiplier(undefined, undefined), 1.0);
  assert.equal(sourceMultiplier('a customer named mattress', undefined), 1.0, 'word-boundary: "mattress" is not Matt');
});

test('freshness: recent lifts, old settles to 1.0, missing/bad ts is neutral, never a penalty', () => {
  assert.ok(freshnessMultiplier(daysAgo(0), NOW) > freshnessMultiplier(daysAgo(30), NOW));
  assert.ok(freshnessMultiplier(daysAgo(30), NOW) > freshnessMultiplier(daysAgo(365), NOW));
  assert.ok(freshnessMultiplier(daysAgo(365), NOW) >= 1.0, 'old is never penalized below 1.0');
  assert.equal(freshnessMultiplier(undefined, NOW), 1.0);
  assert.equal(freshnessMultiplier('not-a-date', NOW), 1.0);
});

// ── the load-bearing recall behaviors ────────────────────────────────────────────────────────────

test('THE FIX: a current decision outranks a stale episode of SLIGHTLY HIGHER raw relevance', () => {
  // The exact CORRECTION-plague shape: an auto-journal episode wins on raw relevance, but the
  // decision that supersedes it must surface first after the re-rank.
  const hits: Rerankable[] = [
    { id: 'stale-episode', score: 2.2, type: 'episode', ts: daysAgo(20), source: 'auto-journal' },
    { id: 'current-decision', score: 2.0, type: 'decision', ts: daysAgo(1), source: 'Matt 2026-07-16' },
  ];
  const out = rerankByAuthority(hits, { nowMs: NOW });
  assert.equal(out[0].id, 'current-decision', 'the decision must surface above the higher-relevance stale episode');
});

test('relevance still dominates: a strongly-more-relevant fact is NOT buried by a fresh low-relevance status', () => {
  const hits: Rerankable[] = [
    { id: 'very-relevant-fact', score: 4.0, type: 'fact', ts: daysAgo(120) },
    { id: 'fresh-status', score: 1.2, type: 'status', ts: daysAgo(0), source: 'Matt' },
  ];
  const out = rerankByAuthority(hits, { nowMs: NOW });
  assert.equal(out[0].id, 'very-relevant-fact', 'a large base-score gap must not be overturned by authority nudges');
});

test('kill-switch OFF is byte-identical to the input order (no re-rank)', () => {
  const hits: Rerankable[] = [
    { id: 'a', score: 1.0, type: 'episode', ts: daysAgo(100) },
    { id: 'b', score: 0.9, type: 'decision', ts: daysAgo(0), source: 'Matt' },
  ];
  const out = rerankByAuthority(hits, { mode: 'off', nowMs: NOW });
  assert.deepEqual(out.map((h) => h.id), ['a', 'b'], 'mode=off must preserve the exact incoming order');
  assert.equal(rerankEnabled('off'), false);
  assert.equal(rerankEnabled(undefined), true, 'default is ON');
  assert.equal(rerankEnabled('ON'), true);
});

test('typeless/tsless rooms (e.g. commons journal) are a NO-OP: order preserved by stable sort', () => {
  // All multipliers resolve to 1.0, so adjusted == base; equal-base ties keep incoming order.
  const hits: Rerankable[] = [
    { id: 'x', score: 3.0 },
    { id: 'y', score: 3.0 },
    { id: 'z', score: 2.0 },
  ];
  const out = rerankByAuthority(hits, { nowMs: NOW });
  assert.deepEqual(out.map((h) => h.id), ['x', 'y', 'z'], 'no signals -> pure relevance order, stable');
});

test('rerank never mutates the input array', () => {
  const hits: Rerankable[] = [
    { id: 'a', score: 1.0, type: 'episode' },
    { id: 'b', score: 1.0, type: 'decision' },
  ];
  const snapshot = hits.map((h) => h.id);
  rerankByAuthority(hits, { nowMs: NOW });
  assert.deepEqual(hits.map((h) => h.id), snapshot, 'input order untouched');
});

test('adjustedScore composes all three factors multiplicatively', () => {
  const hit: Rerankable = { score: 2.0, type: 'decision', ts: daysAgo(0), source: 'Matt' };
  const expected = 2.0 * authorityMultiplier('decision') * sourceMultiplier('Matt', undefined) * freshnessMultiplier(daysAgo(0), NOW);
  assert.ok(Math.abs(adjustedScore(hit, NOW) - expected) < 1e-9);
  assert.equal(adjustedScore({ score: undefined }, NOW), 0, 'missing score -> 0 base');
});
