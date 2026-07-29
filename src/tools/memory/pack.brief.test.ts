import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefPack, PACK_BRIEF_TEXT_CAP, PACK_BRIEF_LIST_CAP, type PackFullData } from './pack.js';

// Pins the P2-3 fix: memory_pack was measured at ~99KB and JIT-offloading, with NO text capping
// and NO superseded-collapsing at all in full mode (unlike wake, which at least capped text).
// These tests pin buildBriefPack's behavior under brief:true.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function fullData(overrides: Partial<PackFullData> = {}): PackFullData {
  return {
    agent: 'cfo',
    status: { id: 's1', text: longText(1200) },
    corrections: Array.from({ length: 15 }, (_, i) => ({ id: `c${i}`, text: longText(1200) })),
    decisions: Array.from({ length: 15 }, (_, i) => ({ id: `d${i}`, text: longText(1200) })),
    recent: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, text: longText(1200) })),
    count: 400,
    ...overrides,
  };
}

test('buildBriefPack collapses a superseded chain in corrections to just the surviving head', () => {
  const data = fullData();
  data.corrections = [
    { id: 'c3', text: 'newest', supersedes: 'c2' },
    { id: 'c2', text: 'middle', supersedes: 'c1' },
    { id: 'c1', text: 'oldest' },
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
    { id: 'd2', text: 'the real decision', supersedes: 'd1' },
    { id: 'd1', text: 'the old, now-wrong decision' },
  ];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.decisions.map((d: any) => d.id),
    ['d2'],
  );
});

test('buildBriefPack never drops an entry nothing supersedes', () => {
  const data = fullData();
  data.corrections = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
  const brief = buildBriefPack(data) as any;
  assert.deepEqual(
    brief.corrections.map((c: any) => c.id).sort(),
    ['a', 'b'],
  );
});

test('buildBriefPack keeps a stable id on every returned entry', () => {
  const brief = buildBriefPack(fullData()) as any;
  for (const c of brief.corrections) assert.equal(typeof c.id, 'string');
  for (const d of brief.decisions) assert.equal(typeof d.id, 'string');
});

test('buildBriefPack caps text fields to PACK_BRIEF_TEXT_CAP', () => {
  const brief = buildBriefPack(fullData()) as any;
  for (const c of brief.corrections) assert.ok(c.text.length <= PACK_BRIEF_TEXT_CAP + 60);
  for (const d of brief.decisions) assert.ok(d.text.length <= PACK_BRIEF_TEXT_CAP + 60);
  assert.ok(brief.status.text.length <= PACK_BRIEF_TEXT_CAP + 60);
});

test('buildBriefPack tightens list lengths (corrections/decisions)', () => {
  const brief = buildBriefPack(fullData()) as any;
  assert.equal(brief.corrections.length, PACK_BRIEF_LIST_CAP);
  assert.equal(brief.decisions.length, PACK_BRIEF_LIST_CAP);
});

test('buildBriefPack drops recent entirely (the biggest duplicate-noise contributor) but preserves count', () => {
  const brief = buildBriefPack(fullData()) as any;
  assert.deepEqual(brief.recent, []);
  assert.equal(brief.count, 400);
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
  const size = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  assert.ok(size < 200, `expected under 200 bytes, got ${size} bytes`);
});

// ---- the actual before/after this PR sets out to fix -----------------------------------------------

test('buildBriefPack, in the ACTUAL wire envelope shape (pretty-printed text + duplicated structuredContent), stays comfortably under the JIT-offload threshold for a realistic large-ledger pack', () => {
  // Mirrors registry.ts's THRESHOLD_CHARS=40000 gate on content[0].text (see result-store.ts
  // shouldOffload). memory_pack's FULL mode had no capping at all, so this fixture (15 corrections
  // + 15 decisions + 30 recent, each at 1200 chars, matching what a real long ledger's entries can
  // run) reproduces the reported ~99KB shape.
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
