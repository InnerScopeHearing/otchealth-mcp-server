import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefPack, PACK_BRIEF_LIST_CAP, PACK_BRIEF_RECENT_FACT_CAP, type PackFullData } from './pack.js';
import { M365_LITE_TEXT_CAP } from './wake.js';

// Pins the P2-3 fix: memory_pack was measured at ~99KB and JIT-offloading, with NO text capping
// and NO superseded-collapsing at all in full mode (unlike wake, which at least capped text).
// These tests pin buildBriefPack's behavior under brief:true.
//
// Fixture shapes are the REAL MemoryEntry shape every field of a pack response actually carries
// (a 2026-07-30 review finding: the original fixtures used only {id, text}, which could not catch
// a bug in capping the real, also-unbounded `source`/`tags[]` fields). See src/memory/store.ts's
// MemoryEntry.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function entry(id: string, type: 'status' | 'correction' | 'decision' | 'fact' | 'pitfall', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type,
    text: longText(1200),
    agent: 'cfo',
    tags: Array.from({ length: 6 }, (_, j) => `tag-${id}-${j}`),
    source: longText(300),
    ...overrides,
  };
}

function fullData(overrides: Partial<PackFullData> = {}): PackFullData {
  return {
    agent: 'cfo',
    status: entry('s1', 'status'),
    corrections: Array.from({ length: 15 }, (_, i) => entry(`c${i}`, 'correction')),
    decisions: Array.from({ length: 15 }, (_, i) => entry(`d${i}`, 'decision')),
    recent: Array.from({ length: 30 }, (_, i) => entry(`r${i}`, i % 2 === 0 ? 'fact' : 'pitfall')),
    count: 400,
    ...overrides,
  };
}

test('buildBriefPack collapses a superseded chain in corrections to just the surviving head', () => {
  const data = fullData();
  data.corrections = [
    entry('c3', 'correction', { text: 'newest', supersedes: 'c2' }),
    entry('c2', 'correction', { text: 'middle', supersedes: 'c1' }),
    entry('c1', 'correction', { text: 'oldest' }),
  ];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.corrections.map((c: any) => c.id),
    ['c3'],
  );
});

test('buildBriefPack collapses superseded decisions (NOT collapsed in full mode today)', () => {
  const data = fullData();
  data.decisions = [
    entry('d2', 'decision', { text: 'the real decision', supersedes: 'd1' }),
    entry('d1', 'decision', { text: 'the old, now-wrong decision' }),
  ];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.decisions.map((d: any) => d.id),
    ['d2'],
  );
});

test('buildBriefPack never drops an entry nothing supersedes', () => {
  const data = fullData();
  data.corrections = [entry('a', 'correction', { text: 'x' }), entry('b', 'correction', { text: 'y' })];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.corrections.map((c: any) => c.id).sort(),
    ['a', 'b'],
  );
});

// ---- global (cross-type) retraction, the 2026-07-30 fix -----------------------------------------

test('buildBriefPack removes a correction that a DECISION supersedes (cross-type retraction, not just within-list)', () => {
  const data = fullData();
  data.corrections = [entry('c1', 'correction', { text: 'the now-retracted correction' })];
  data.decisions = [entry('d1', 'decision', { text: 'a decision that retracts c1', supersedes: 'c1' })];
  data.recent = [];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.corrections.map((c: any) => c.id),
    [],
  );
  assert.deepEqual(
    brief.decisions.map((d: any) => d.id),
    ['d1'],
  );
});

test('buildBriefPack removes a fact from recent when a correction supersedes it (cross-type retraction reaching into recent)', () => {
  const data = fullData();
  data.corrections = [entry('c1', 'correction', { text: 'retracts r1', supersedes: 'r1' })];
  data.decisions = [];
  data.recent = [entry('r1', 'fact', { text: 'a fact later retracted' })];
  const brief = buildBriefPack(data) as any;
  assert.ok(!brief.recent.some((r: any) => r.id === 'r1'));
});

// ---- stable id + size discipline (by VALUE SHAPE, not by a hardcoded field name) -----------------

test('buildBriefPack keeps a stable id on every returned entry', () => {
  const brief = buildBriefPack(fullData()) as any;
  for (const c of brief.corrections) assert.equal(typeof c.id, 'string');
  for (const d of brief.decisions) assert.equal(typeof d.id, 'string');
  for (const r of brief.recent) assert.equal(typeof r.id, 'string');
});

test('buildBriefPack caps every long field regardless of its name (text, source, tags[])', () => {
  const brief = buildBriefPack(fullData()) as any;
  const capSlack = M365_LITE_TEXT_CAP + 60; // truncation marker overhead
  for (const c of brief.corrections) {
    assert.ok(c.text.length <= capSlack);
    assert.ok(c.source.length <= capSlack, `expected source capped, got ${c.source.length}`);
    assert.ok(c.tags.length <= 2, `expected tags array capped, got ${c.tags.length}`);
  }
  for (const d of brief.decisions) assert.ok(d.text.length <= capSlack);
  assert.ok(brief.status.text.length <= capSlack);
});

test('buildBriefPack tightens list lengths (corrections/decisions)', () => {
  const brief = buildBriefPack(fullData()) as any;
  assert.equal(brief.corrections.length, PACK_BRIEF_LIST_CAP);
  assert.equal(brief.decisions.length, PACK_BRIEF_LIST_CAP);
});

test('buildBriefPack replaces recent with a small, retraction-filtered fact/pitfall subset -- NOT emptied -- and preserves count', () => {
  const brief = buildBriefPack(fullData()) as any;
  assert.ok(brief.recent.length > 0, 'expected a non-empty bounded recent subset');
  assert.ok(brief.recent.length <= PACK_BRIEF_RECENT_FACT_CAP);
  for (const r of brief.recent) assert.ok(r.type === 'fact' || r.type === 'pitfall');
  assert.equal(brief.count, 400);
});

test('buildBriefPack excludes correction/decision-typed entries from recent (already covered above)', () => {
  const data = fullData();
  data.recent = [entry('r1', 'correction', { text: 'should never appear in recent' }), entry('r2', 'fact', { text: 'a real fact' })];
  const brief = buildBriefPack(data) as any;
  assert.ok(!brief.recent.some((r: any) => r.id === 'r1'), 'a correction-typed entry must never appear in recent');
  assert.ok(brief.recent.some((r: any) => r.id === 'r2'), 'a real fact-typed entry must still appear in recent');
});

test('buildBriefPack keeps field names/shape identical to the full response (no outputShape violation)', () => {
  const brief = buildBriefPack(fullData()) as Record<string, unknown>;
  assert.equal(typeof brief.agent, 'string');
  assert.ok(Array.isArray(brief.corrections));
  assert.ok(Array.isArray(brief.decisions));
  assert.ok(Array.isArray(brief.recent));
  assert.equal(typeof brief.count, 'number');
});

test('buildBriefPack handles a null status without throwing', () => {
  const data = fullData({ status: null });
  const brief = buildBriefPack(data) as any;
  assert.equal(brief.status, null);
});

test('buildBriefPack on an empty pack (new agent, nothing set up yet) stays tiny and well-formed', () => {
  const data: PackFullData = { agent: 'newagent', status: null, corrections: [], decisions: [], recent: [], count: 0 };
  const brief = buildBriefPack(data) as any;
  assert.equal(brief.status, null);
  assert.deepEqual(brief.recent, []);
  const size = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  assert.ok(size < 200, `expected under 200 bytes, got ${size} bytes`);
});

// ---- the actual before/after this PR sets out to fix -----------------------------------------------

test('buildBriefPack, in the ACTUAL wire envelope shape (pretty-printed text + duplicated structuredContent), stays comfortably under the JIT-offload threshold for a realistic large-ledger pack', () => {
  // Mirrors registry.ts's THRESHOLD_CHARS=40000 gate on content[0].text (see result-store.ts
  // shouldOffload). memory_pack's FULL mode had no capping at all, so this fixture (15 corrections
  // + 15 decisions + 30 recent, each at 1200 chars plus a 300-char source and a 6-item tags array,
  // matching what a real long ledger's entries can run) reproduces the reported ~99KB shape.
  const full = fullData();
  const fullContentText = JSON.stringify(full, null, 2);
  const fullBytes = Buffer.byteLength(fullContentText, 'utf8');

  const brief = buildBriefPack(full);
  const briefContentText = JSON.stringify(brief, null, 2);
  const structuredContent = { result: brief, compliance_warning: null, correlation_id: 'c'.repeat(36), dry_run: false };
  const briefTotalBytes = Buffer.byteLength(briefContentText, 'utf8') + Buffer.byteLength(JSON.stringify(structuredContent), 'utf8');

  assert.ok(briefTotalBytes < 40000, `expected brief wire envelope under the 40000-char offload threshold, got ${briefTotalBytes} bytes`);
  assert.ok(briefTotalBytes < fullBytes, `expected brief (${briefTotalBytes}) meaningfully smaller than full (${fullBytes})`);
  assert.ok(fullBytes > 40000, `expected the full fixture to reproduce the oversized-response shape, got ${fullBytes} bytes`);
});
