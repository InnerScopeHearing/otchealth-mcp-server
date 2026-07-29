import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBriefWake,
  WAKE_BRIEF_TEXT_CAP,
  WAKE_BRIEF_LIST_CAP,
  WAKE_BRIEF_MEMORY_CAP,
  WAKE_BRIEF_TASK_CAP,
  WAKE_BRIEF_INBOX_CAP,
  WAKE_BRIEF_INBOUND_CAP,
  type WakeFullData,
} from './wake.js';

// Pins the P2-3 fix: a real bug report (CFO agent, a long-lived session, NOT the M365 lane
// wake.m365-lite.test.ts covers) found wake() routinely landing at ~94KB and JIT-offloading. These
// tests pin buildBriefWake's behavior under brief:true -- collapse superseded entries, cap text,
// tighten list lengths, keep ids for drill-down, and stay well under the offload threshold for a
// realistic default-limit ledger.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function fullData(overrides: Partial<WakeFullData> = {}): WakeFullData {
  return {
    agent: 'cfo',
    pack: {
      configured: true,
      status: { id: 's1', text: longText(900) },
      corrections: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, text: longText(900) })),
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: longText(900) })),
      recent: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: longText(900) })),
      count: 120,
    },
    memory_records: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: longText(900) })),
    tasks: {
      configured: true,
      active: Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, text: longText(600) })),
      counts: { open: 5, claimed: 3, in_progress: 2 },
    },
    inbox: {
      configured: true,
      count: 8,
      preview: Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, text: longText(400) })),
    },
    inbound: {
      configured: true,
      count: 3,
      sinceMarker: '2026-07-26T00:00:00Z',
      notes: Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, text: longText(900) })),
    },
    errors: [],
    doctrine: {
      definition_of_done: 'merged + CI green; deployed + verified; an independent live call; a ledger artifact URI; a monitor whose silence pages',
      pitfalls: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, text: longText(220), source: 'shared_feed' as const })),
      standing_directives: ['a', 'b', 'c', 'd'],
    },
    ...overrides,
  };
}

// ---- collapsing superseded entries (the CORE ask) -----------------------------------------------

test('buildBriefWake collapses a superseded chain in pack.corrections to just the surviving head', () => {
  const data = fullData();
  data.pack.corrections = [
    { id: 'c3', text: 'newest', supersedes: 'c2' },
    { id: 'c2', text: 'middle', supersedes: 'c1' },
    { id: 'c1', text: 'oldest' },
  ];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.corrections.map((c: any) => c.id),
    ['c3'],
  );
});

test('buildBriefWake collapses superseded pack.decisions (NOT collapsed in full mode today)', () => {
  const data = fullData();
  data.pack.decisions = [
    { id: 'd2', text: 'the real decision', supersedes: 'd1' },
    { id: 'd1', text: 'the old, now-wrong decision' },
  ];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.decisions.map((d: any) => d.id),
    ['d2'],
  );
});

test('buildBriefWake collapses superseded memory_records (Cosmos, NOT collapsed in full mode today)', () => {
  const data = fullData();
  data.memory_records = [
    { id: 'm2', text: 'the corrected memory', supersedes: 'm1' },
    { id: 'm1', text: 'the retracted memory' },
  ];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.memory_records.map((r: any) => r.id),
    ['m2'],
  );
});

test('buildBriefWake never drops an entry nothing supersedes', () => {
  const data = fullData();
  data.pack.corrections = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.corrections.map((c: any) => c.id).sort(),
    ['a', 'b'],
  );
});

// ---- stable id field for drill-down --------------------------------------------------------------

test('buildBriefWake keeps a stable id on every returned entry (corrections, decisions, memory_records, tasks, inbox, inbound)', () => {
  const brief = buildBriefWake(fullData()) as any;
  for (const c of brief.pack.corrections) assert.equal(typeof c.id, 'string');
  for (const d of brief.pack.decisions) assert.equal(typeof d.id, 'string');
  for (const r of brief.memory_records) assert.equal(typeof r.id, 'string');
  for (const t of brief.tasks.active) assert.equal(typeof t.id, 'string');
  for (const p of brief.inbox.preview) assert.equal(typeof p.id, 'string');
  for (const n of brief.inbound.notes) assert.equal(typeof n.id, 'string');
});

// ---- size discipline ------------------------------------------------------------------------------

test('buildBriefWake caps text fields to WAKE_BRIEF_TEXT_CAP', () => {
  const brief = buildBriefWake(fullData()) as any;
  for (const c of brief.pack.corrections) assert.ok(c.text.length <= WAKE_BRIEF_TEXT_CAP + 60);
  for (const d of brief.pack.decisions) assert.ok(d.text.length <= WAKE_BRIEF_TEXT_CAP + 60);
  for (const r of brief.memory_records) assert.ok(r.text.length <= WAKE_BRIEF_TEXT_CAP + 60);
  for (const t of brief.tasks.active) assert.ok(t.text.length <= WAKE_BRIEF_TEXT_CAP + 60);
  assert.ok(brief.pack.status.text.length <= WAKE_BRIEF_TEXT_CAP + 60);
});

test('buildBriefWake tightens list lengths (corrections/decisions/memory_records/tasks/inbox/inbound)', () => {
  const brief = buildBriefWake(fullData()) as any;
  assert.equal(brief.pack.corrections.length, WAKE_BRIEF_LIST_CAP);
  assert.equal(brief.pack.decisions.length, WAKE_BRIEF_LIST_CAP);
  assert.equal(brief.memory_records.length, WAKE_BRIEF_MEMORY_CAP);
  assert.equal(brief.tasks.active.length, WAKE_BRIEF_TASK_CAP);
  assert.equal(brief.inbox.preview.length, WAKE_BRIEF_INBOX_CAP);
  assert.equal(brief.inbound.notes.length, WAKE_BRIEF_INBOUND_CAP);
});

test('buildBriefWake drops pack.recent entirely (the biggest duplicate-noise contributor) but preserves pack.count', () => {
  const brief = buildBriefWake(fullData()) as any;
  assert.deepEqual(brief.pack.recent, []);
  assert.equal(brief.pack.count, 120);
});

test('buildBriefWake preserves counts (tasks.counts, inbox.count, inbound.count) even though it trims the underlying lists', () => {
  const brief = buildBriefWake(fullData()) as any;
  assert.deepEqual(brief.tasks.counts, { open: 5, claimed: 3, in_progress: 2 });
  assert.equal(brief.inbox.count, 8);
  assert.equal(brief.inbound.count, 3);
});

test('buildBriefWake strips Cosmos internal bookkeeping fields from memory_records and tasks.active', () => {
  const data = fullData();
  data.memory_records = [{ id: 'm1', text: 'x', _rid: 'r', _self: 's', _etag: 'e', _attachments: 'a', _ts: 1 }];
  data.tasks.active = [{ id: 't1', text: 'x', _rid: 'r', _self: 's', _etag: 'e', _attachments: 'a', _ts: 1 }];
  const brief = buildBriefWake(data) as any;
  for (const rec of [...brief.memory_records, ...brief.tasks.active]) {
    for (const internalField of ['_rid', '_self', '_etag', '_attachments', '_ts']) {
      assert.ok(!(internalField in rec), `expected ${internalField} stripped, got ${JSON.stringify(rec)}`);
    }
  }
});

test('buildBriefWake keeps field names/shapes identical to the full response (no outputShape violation)', () => {
  const brief = buildBriefWake(fullData()) as Record<string, unknown>;
  assert.equal(typeof brief.agent, 'string');
  assert.equal(typeof brief.pack, 'object');
  assert.ok(Array.isArray(brief.memory_records));
  assert.equal(typeof brief.tasks, 'object');
  assert.equal(typeof brief.inbox, 'object');
  assert.equal(typeof brief.inbound, 'object');
  assert.ok(Array.isArray(brief.errors));
  assert.equal(typeof brief.doctrine, 'object');
});

test('buildBriefWake keeps doctrine unchanged (already small; standing operating context, not a size driver)', () => {
  const data = fullData();
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(brief.doctrine, data.doctrine);
});

test('buildBriefWake handles a null pack.status without throwing', () => {
  const data = fullData();
  data.pack.status = null;
  const brief = buildBriefWake(data) as any;
  assert.equal(brief.pack.status, null);
});

test('buildBriefWake on an unconfigured/empty wake (new agent, nothing set up yet) stays tiny and well-formed', () => {
  const data = fullData({
    pack: { configured: false, status: null, corrections: [], decisions: [], recent: [], count: 0 },
    memory_records: [],
    tasks: { configured: false, active: [], counts: {} },
    inbox: { configured: false, count: 0, preview: [] },
    inbound: { configured: false, count: 0, sinceMarker: '', notes: [] },
    doctrine: { definition_of_done: 'x', pitfalls: [], standing_directives: [] },
  });
  const brief = buildBriefWake(data) as any;
  assert.equal(brief.pack.configured, false);
  const size = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  assert.ok(size < 1500, `expected under 1.5KB, got ${size} bytes`);
});

// ---- the actual before/after this PR sets out to fix -----------------------------------------------

test('buildBriefWake, in the ACTUAL wire envelope shape (pretty-printed text + duplicated structuredContent), stays comfortably under the JIT-offload threshold for a realistic default-limit ledger', () => {
  // Mirrors registry.ts's THRESHOLD_CHARS=40000 gate on content[0].text specifically (see
  // result-store.ts shouldOffload). This fixture uses wake's actual DEFAULT limits (8 corrections,
  // 8 decisions, 10 recent -- dropped in brief, 12 memory records, 15 tasks) each near wake's own
  // full-mode TEXT_CAP=900, which is the shape that produced the reported ~94KB in full mode.
  const full = fullData();
  const fullContentText = JSON.stringify(full, null, 2);
  const fullBytes = Buffer.byteLength(fullContentText, 'utf8');

  const brief = buildBriefWake(full);
  const briefContentText = JSON.stringify(brief, null, 2);
  const structuredContent = { result: brief, compliance_warning: null, correlation_id: 'c'.repeat(36), dry_run: false };
  const briefTotalBytes = Buffer.byteLength(briefContentText, 'utf8') + Buffer.byteLength(JSON.stringify(structuredContent), 'utf8');

  assert.ok(briefTotalBytes < 40000, `expected brief wire envelope under the 40000-char offload threshold, got ${briefTotalBytes} bytes`);
  assert.ok(briefTotalBytes < fullBytes, `expected brief (${briefTotalBytes}) meaningfully smaller than full (${fullBytes})`);
  // The full fixture alone (single copy, no pretty-print/duplication overhead) is already well past
  // the threshold, matching the reported ~94KB symptom once the real wire envelope's overhead is
  // added on top -- pinning that this fixture is a faithful reproduction, not a strawman.
  assert.ok(fullBytes > 20000, `expected the full fixture to reproduce the oversized-response shape, got ${fullBytes} bytes`);
});
