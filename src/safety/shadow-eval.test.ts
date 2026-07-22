// Own file (own `node --test` child process): loadEnv() memoizes per-process (see
// agentstate/cosmos-keymode.test.ts's header for the full explanation). This file deliberately
// leaves COSMOS_ENDPOINT UNSET for its whole lifetime, so captureShadowComparison's "Cosmos not
// configured -> no-op" fail-open path is exercised cleanly and consistently across every test here.
// Uses a DYNAMIC import (not a static one) so the env vars below are guaranteed to be set BEFORE
// shadow-eval.js (and its loadEnv()-consuming dependencies) are evaluated -- a static import is
// hoisted ahead of any top-level code in this file, which would defeat the ordering; mirrors
// azure/search.test.ts's exact preamble convention (see its header comment).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.COSMOS_ENDPOINT;
delete process.env.COSMOS_KEY;

const {
  parseShadowEvalMode,
  parseShadowSampleRate,
  DEFAULT_SHADOW_SAMPLE_RATE,
  mulberry32,
  shouldSampleShadow,
  resolveShadowStrategy,
  listShadowStrategies,
  summarizeHits,
  sanitizeShadowQuery,
  buildShadowComparisonText,
  captureShadowComparison,
  SHADOW_EVAL_AGENT,
  MAX_COMPARISON_CHARS,
  isRingGatedIndexName,
  RING_GATED_INDEX_NAMES,
} = await import('./shadow-eval.js');
const { INDEX_LANES } = await import('../tools/kb/search-privileged.js');

// ---- parseShadowEvalMode -----------------------------------------------------------------------

test('parseShadowEvalMode: "on" parses to on, case-insensitive and trimmed', () => {
  assert.equal(parseShadowEvalMode('on'), 'on');
  assert.equal(parseShadowEvalMode('ON'), 'on');
  assert.equal(parseShadowEvalMode('  On  '), 'on');
});

test('parseShadowEvalMode: unset, empty, or garbage all default to off', () => {
  assert.equal(parseShadowEvalMode(undefined), 'off');
  assert.equal(parseShadowEvalMode(''), 'off');
  assert.equal(parseShadowEvalMode('off'), 'off');
  assert.equal(parseShadowEvalMode('banana'), 'off');
  assert.equal(parseShadowEvalMode('true'), 'off');
});

// ---- parseShadowSampleRate ---------------------------------------------------------------------

test('parseShadowSampleRate: a valid fraction parses through unchanged', () => {
  assert.equal(parseShadowSampleRate('0.05'), 0.05);
  assert.equal(parseShadowSampleRate('0.1'), 0.1);
  assert.equal(parseShadowSampleRate('0'), 0);
  assert.equal(parseShadowSampleRate('1'), 1);
});

test('parseShadowSampleRate: unset/empty/unparseable falls back to the 5% default', () => {
  assert.equal(parseShadowSampleRate(undefined), DEFAULT_SHADOW_SAMPLE_RATE);
  assert.equal(parseShadowSampleRate(''), DEFAULT_SHADOW_SAMPLE_RATE);
  assert.equal(parseShadowSampleRate('banana'), DEFAULT_SHADOW_SAMPLE_RATE);
  assert.equal(parseShadowSampleRate('NaN'), DEFAULT_SHADOW_SAMPLE_RATE);
});

test('parseShadowSampleRate: clamps out-of-range values into [0, 1] rather than failing', () => {
  assert.equal(parseShadowSampleRate('1.5'), 1);
  assert.equal(parseShadowSampleRate('150'), 1);
  assert.equal(parseShadowSampleRate('-1'), 0);
  assert.equal(parseShadowSampleRate('-0.5'), 0);
});

// ---- mulberry32 (seedable PRNG) -----------------------------------------------------------------

test('mulberry32: the SAME seed produces the SAME sequence (deterministic)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('mulberry32: different seeds produce different sequences', () => {
  const a = mulberry32(1);
  const b = mulberry32(2);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test('mulberry32: every draw stays within [0, 1)', () => {
  const rand = mulberry32(999);
  for (let i = 0; i < 5000; i++) {
    const v = rand();
    assert.ok(v >= 0 && v < 1, `draw #${i} = ${v} out of range`);
  }
});

// ---- shouldSampleShadow (the sampling decision) -------------------------------------------------

test('shouldSampleShadow: sampleRate <= 0 is always false and never draws from rand', () => {
  let drew = false;
  const rand = () => {
    drew = true;
    return 0;
  };
  assert.equal(shouldSampleShadow(0, rand), false);
  assert.equal(shouldSampleShadow(-1, rand), false);
  assert.equal(drew, false, 'a sampleRate <= 0 must be a fast path that never consumes a rand() draw');
});

test('shouldSampleShadow: sampleRate >= 1 is always true and never draws from rand', () => {
  let drew = false;
  const rand = () => {
    drew = true;
    return 0.999;
  };
  assert.equal(shouldSampleShadow(1, rand), true);
  assert.equal(shouldSampleShadow(2, rand), true);
  assert.equal(drew, false, 'a sampleRate >= 1 must be a fast path that never consumes a rand() draw');
});

test('shouldSampleShadow: draws exactly once and compares against the threshold', () => {
  let draws = 0;
  const below = () => {
    draws++;
    return 0.02;
  };
  assert.equal(shouldSampleShadow(0.05, below), true);
  assert.equal(draws, 1);

  draws = 0;
  const above = () => {
    draws++;
    return 0.9;
  };
  assert.equal(shouldSampleShadow(0.05, above), false);
  assert.equal(draws, 1);
});

test('shouldSampleShadow: with a FIXED seed, the observed sampling fraction over many trials lands close to the configured rate', () => {
  const N = 20000;
  const rate = 0.05;
  const rand = mulberry32(42);
  let sampled = 0;
  for (let i = 0; i < N; i++) {
    if (shouldSampleShadow(rate, rand)) sampled++;
  }
  const observed = sampled / N;
  // Deterministic given the fixed seed 42 -- this bound is generous (+/- 1.5 percentage points on a
  // 5% target over 20k draws) to stay robust to a PRNG implementation with a different but still
  // uniform distribution, while still meaningfully proving "roughly the right fraction," not "any
  // fraction at all."
  assert.ok(
    Math.abs(observed - rate) < 0.015,
    `observed sampling fraction ${observed} should be close to configured rate ${rate}`,
  );
});

test('shouldSampleShadow: reproducible end to end -- the SAME seed yields the SAME count of sampled calls', () => {
  const run = () => {
    const rand = mulberry32(7);
    let sampled = 0;
    for (let i = 0; i < 5000; i++) if (shouldSampleShadow(0.1, rand)) sampled++;
    return sampled;
  };
  assert.equal(run(), run());
});

// ---- strategy registry ---------------------------------------------------------------------------

test('resolveShadowStrategy: known names resolve with their exact registered overrides', () => {
  assert.deepEqual(resolveShadowStrategy('baseline'), { name: 'baseline', overrides: {} });
  assert.deepEqual(resolveShadowStrategy('demote-off'), { name: 'demote-off', overrides: { includeOpsOverride: true } });
  assert.deepEqual(resolveShadowStrategy('demote-on'), { name: 'demote-on', overrides: { includeOpsOverride: false } });
  assert.deepEqual(resolveShadowStrategy('rerank-off'), { name: 'rerank-off', overrides: { rerankModeOverride: 'off' } });
  assert.deepEqual(resolveShadowStrategy('rerank-on'), { name: 'rerank-on', overrides: { rerankModeOverride: 'on' } });
});

test('resolveShadowStrategy: case-insensitive and trimmed', () => {
  assert.equal(resolveShadowStrategy('  DEMOTE-OFF  ').name, 'demote-off');
  assert.equal(resolveShadowStrategy('Rerank-On').name, 'rerank-on');
});

test('resolveShadowStrategy: unknown/unset name falls back to baseline, never throws', () => {
  assert.equal(resolveShadowStrategy(undefined).name, 'baseline');
  assert.equal(resolveShadowStrategy('').name, 'baseline');
  assert.equal(resolveShadowStrategy('not-a-real-strategy').name, 'baseline');
  assert.deepEqual(resolveShadowStrategy('not-a-real-strategy').overrides, {});
});

test('resolveShadowStrategy: every name listShadowStrategies() reports actually resolves to itself', () => {
  for (const name of listShadowStrategies()) {
    assert.equal(resolveShadowStrategy(name).name, name);
  }
});

test('listShadowStrategies: includes at least one demotion variant and one rerank variant (the two example classes named in the Wave 7 spec)', () => {
  const names = listShadowStrategies();
  assert.ok(names.some((n) => n.startsWith('demote-')));
  assert.ok(names.some((n) => n.startsWith('rerank-')));
});

// ---- summarizeHits ---------------------------------------------------------------------------

test('summarizeHits: projects id/score/type only, never any other field, and caps at 10', () => {
  const hits = Array.from({ length: 15 }, (_, i) => ({
    id: `m_${i}`,
    score: i,
    type: 'fact',
    text: 'this text must NEVER be persisted by the shadow-eval capture',
  }));
  const out = summarizeHits(hits);
  assert.equal(out.length, 10);
  for (const h of out) {
    assert.deepEqual(Object.keys(h).sort(), ['id', 'score', 'type']);
  }
  assert.equal(out[0].id, 'm_0');
  assert.equal(out[0].score, 0);
});

test('summarizeHits: empty/null/undefined input returns an empty array, never throws', () => {
  assert.deepEqual(summarizeHits([]), []);
  assert.deepEqual(summarizeHits(null), []);
  assert.deepEqual(summarizeHits(undefined), []);
});

test('summarizeHits: tolerates missing/odd fields (non-string id, NaN score, missing type)', () => {
  const out = summarizeHits([
    { id: 42, score: Number.NaN, type: undefined },
    { id: undefined, score: 3, type: 'decision' },
    {},
  ]);
  assert.deepEqual(out, [
    { id: '42', score: null, type: null },
    { id: '', score: 3, type: 'decision' },
    { id: '', score: null, type: null },
  ]);
});

// ---- sanitizeShadowQuery -----------------------------------------------------------------------

test('sanitizeShadowQuery: an ordinary short query passes through unchanged', () => {
  assert.equal(sanitizeShadowQuery('what is the ASC key id'), 'what is the ASC key id');
});

test('sanitizeShadowQuery: caps a very long query with a truncation marker', () => {
  // Space-separated words (NOT a base64-alphabet run) so this exercises the length-cap path
  // distinctly from looksLikeSecretValue's long-base64-run heuristic (covered separately below).
  const long = 'what is the current ASC key id and rotation schedule '.repeat(10);
  assert.ok(long.length > 300);
  const out = sanitizeShadowQuery(long);
  assert.ok(out.length < long.length);
  assert.ok(out.includes('truncated'));
});

test('sanitizeShadowQuery: redacts a query that itself looks like a secret blob (defense in depth)', () => {
  const jwt = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  assert.equal(sanitizeShadowQuery(jwt), '[REDACTED]');
});

test('sanitizeShadowQuery: an empty string passes through unchanged and never throws', () => {
  assert.equal(sanitizeShadowQuery(''), '');
});

// ---- buildShadowComparisonText ------------------------------------------------------------------

const LIVE_HITS = [
  { id: 'm_1', score: 3.1, type: 'fact' },
  { id: 'm_2', score: 2.9, type: 'decision' },
];
const SHADOW_HITS = [
  { id: 'm_2', score: 3.4, type: 'decision' },
  { id: 'm_1', score: 3.0, type: 'fact' },
];

test('buildShadowComparisonText: is pure -- same input, same output', () => {
  const input = {
    index: 'memory-exec',
    query: 'ASC key id',
    top: 8,
    strategy: 'demote-off',
    live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
    shadow: { mode: 'hybrid+semantic', hits: SHADOW_HITS },
    elapsedMs: 123,
  };
  assert.equal(buildShadowComparisonText(input), buildShadowComparisonText(input));
});

test('buildShadowComparisonText: round-trips as valid JSON carrying both live and shadow hit lists', () => {
  const text = buildShadowComparisonText({
    index: 'memory-exec',
    query: 'ASC key id',
    top: 8,
    strategy: 'demote-off',
    live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
    shadow: { mode: 'keyword', hits: SHADOW_HITS },
    elapsedMs: 42,
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.index, 'memory-exec');
  assert.equal(parsed.strategy, 'demote-off');
  assert.equal(parsed.top, 8);
  assert.equal(parsed.query, 'ASC key id');
  assert.equal(parsed.live.mode, 'hybrid+semantic');
  assert.equal(parsed.live.hits.length, 2);
  assert.equal(parsed.shadow.mode, 'keyword');
  assert.equal(parsed.shadow.hits.length, 2);
  assert.equal(parsed.elapsed_ms, 42);
});

test('buildShadowComparisonText: shadow:null (the re-run threw) is carried through with shadow_error', () => {
  const text = buildShadowComparisonText({
    index: 'memory-exec',
    query: 'ASC key id',
    top: 8,
    strategy: 'rerank-off',
    live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
    shadow: null,
    shadowError: 'search 500',
    elapsedMs: 10,
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.shadow, null);
  assert.equal(parsed.shadow_error, 'search 500');
});

test('buildShadowComparisonText: never exceeds MAX_COMPARISON_CHARS, truncating to a labeled preview instead', () => {
  const hugeHits = Array.from({ length: 10 }, (_, i) => ({
    id: `m_${'x'.repeat(400)}_${i}`,
    score: i,
    type: 'fact',
  }));
  const text = buildShadowComparisonText({
    index: 'memory-exec',
    query: 'q',
    top: 25,
    strategy: 'baseline',
    live: { mode: 'hybrid+semantic', hits: hugeHits },
    shadow: { mode: 'hybrid+semantic', hits: hugeHits },
    elapsedMs: 5,
  });
  assert.ok(text.length <= MAX_COMPARISON_CHARS + 200, `expected a bounded truncated payload, got ${text.length} chars`);
  const parsed = JSON.parse(text);
  assert.equal(parsed._truncated, true);
});

test('buildShadowComparisonText: redacts a secret-shaped query inside the persisted payload', () => {
  const jwt = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  const text = buildShadowComparisonText({
    index: 'memory-exec',
    query: jwt,
    top: 8,
    strategy: 'baseline',
    live: { mode: 'keyword', hits: [] },
    shadow: null,
    elapsedMs: 1,
  });
  assert.ok(!text.includes(jwt));
  assert.ok(text.includes('[REDACTED]'));
});

// ---- captureShadowComparison (IO shell, fail-open) ----------------------------------------------

test('captureShadowComparison: resolves cleanly (no throw) when Cosmos is not configured', async () => {
  // COSMOS_ENDPOINT is deleted at file scope above and never set anywhere in this file.
  await assert.doesNotReject(
    captureShadowComparison({
      index: 'memory-exec',
      query: 'test query',
      top: 8,
      strategy: 'baseline',
      live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
      shadow: { mode: 'hybrid+semantic', hits: SHADOW_HITS },
      elapsedMs: 5,
    }),
  );
});

test('captureShadowComparison: resolves to undefined (writes nothing) rather than a truthy result when unconfigured', async () => {
  const result = await captureShadowComparison({
    index: 'memory-exec',
    query: 'test query',
    top: 8,
    strategy: 'baseline',
    live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
    shadow: null,
    elapsedMs: 1,
  });
  assert.equal(result, undefined);
});

test('captureShadowComparison: never throws even given a deliberately malformed comparison input', async () => {
  await assert.doesNotReject(
    captureShadowComparison({
      index: '',
      query: '',
      top: Number.NaN,
      strategy: '',
      live: { mode: '', hits: [] },
      shadow: null,
      elapsedMs: Number.NaN,
    }),
  );
});

test('SHADOW_EVAL_AGENT is a stable, valid agent id (fixed Cosmos partition for a nightly job to enumerate)', () => {
  assert.equal(SHADOW_EVAL_AGENT, 'shadow-eval');
  assert.match(SHADOW_EVAL_AGENT, /^[a-z0-9][a-z0-9_-]{0,40}$/);
});

// ---- CROSS-RING GATE (isRingGatedIndexName / RING_GATED_INDEX_NAMES) -----------------------------
// The comparison record's destination (memory-exec, an OPEN index) is more permissive than a
// ring-gated finance/legal room the live query could have actually been against (hybridSearch is
// also kb_search_privileged's seam). This list is DUPLICATED from tools/kb/search-privileged.ts's
// INDEX_LANES (not imported, to avoid a real import cycle -- see the doc comment on
// isRingGatedIndexName), so this test is the thing that actually keeps them from silently drifting
// apart: it imports INDEX_LANES directly (a test file is not part of the runtime import graph, so
// no cycle risk here) and asserts the two enumerations name the exact same rooms.

test('RING_GATED_INDEX_NAMES matches tools/kb/search-privileged.ts INDEX_LANES exactly (no drift)', () => {
  const fromSearchPrivileged = Object.keys(INDEX_LANES).sort();
  const fromShadowEval = [...RING_GATED_INDEX_NAMES].sort();
  assert.deepEqual(fromShadowEval, fromSearchPrivileged);
});

test('isRingGatedIndexName: every ring-gated room name is recognized', () => {
  for (const name of Object.keys(INDEX_LANES)) {
    assert.equal(isRingGatedIndexName(name), true, `${name} should be ring-gated`);
  }
});

test('isRingGatedIndexName: an open room (memory-exec, commons-company-journal) or an unknown name is NOT ring-gated', () => {
  assert.equal(isRingGatedIndexName('memory-exec'), false);
  assert.equal(isRingGatedIndexName('commons-company-journal'), false);
  assert.equal(isRingGatedIndexName('some-room-that-does-not-exist'), false);
  assert.equal(isRingGatedIndexName(''), false);
});

test('captureShadowComparison: SKIPS a ring-gated index entirely (never writes, even if Cosmos were configured)', async () => {
  const result = await captureShadowComparison({
    index: 'finance-cfo-memory',
    query: 'burn rate before the public filing',
    top: 8,
    strategy: 'baseline',
    live: { mode: 'hybrid+semantic', hits: LIVE_HITS },
    shadow: { mode: 'hybrid+semantic', hits: SHADOW_HITS },
    elapsedMs: 5,
  });
  assert.equal(result, undefined, 'a ring-gated index must never reach writeMemory, regardless of Cosmos configuration');
});
