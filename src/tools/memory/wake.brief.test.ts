import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBriefWake,
  computeRetractedIds,
  WAKE_BRIEF_LIST_CAP,
  WAKE_BRIEF_MEMORY_CAP,
  WAKE_BRIEF_TASK_CAP,
  WAKE_BRIEF_INBOX_CAP,
  WAKE_BRIEF_INBOUND_CAP,
  WAKE_BRIEF_RECENT_FACT_CAP,
  M365_LITE_TEXT_CAP,
  type WakeFullData,
} from './wake.js';

// Pins the P2-3 fix: a real bug report (CFO agent, a long-lived session, NOT the M365 lane
// wake.m365-lite.test.ts covers) found wake() routinely landing at ~94KB and JIT-offloading. These
// tests pin buildBriefWake's behavior under brief:true -- collapse superseded entries GLOBALLY
// (not just within one list), cap every field by SHAPE (not just a hardcoded `text` name), tighten
// list lengths, keep ids for drill-down, and stay well under the offload threshold for a realistic
// default-limit ledger.
//
// Fixture shapes are the REAL record shapes each section actually returns (a 2026-07-30 review
// finding: the original fixtures used a fake {id, text} shape for every section, which could not
// catch a bug in capping a Task's real `description`/`notes[]` fields or a ReadMessage's real
// `message_id`/`subject`/`body` fields -- neither of which is `text`, and ReadMessage has no `id`
// at all, only `message_id`). See src/agentstate/ledger.ts's Task, src/agentstate/queue.ts's
// ReadMessage, src/agentstate/memory.ts's MemoryRecord, and src/memory/store.ts's MemoryEntry.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function fullData(overrides: Partial<WakeFullData> = {}): WakeFullData {
  return {
    agent: 'cfo',
    pack: {
      configured: true,
      status: { id: 's1', type: 'status', text: longText(900), agent: 'cfo', tags: [] },
      corrections: Array.from({ length: 8 }, (_, i) => ({
        id: `c${i}`,
        type: 'correction',
        text: longText(900),
        agent: 'cfo',
        tags: Array.from({ length: 6 }, (_, j) => `tag-${i}-${j}`),
        source: longText(300),
      })),
      decisions: Array.from({ length: 8 }, (_, i) => ({
        id: `d${i}`,
        type: 'decision',
        text: longText(900),
        agent: 'cfo',
        tags: Array.from({ length: 6 }, (_, j) => `tag-${i}-${j}`),
        source: longText(300),
      })),
      recent: Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        type: i % 2 === 0 ? 'fact' : 'pitfall',
        text: longText(900),
        agent: 'cfo',
        tags: [],
      })),
      count: 120,
    },
    memory_records: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      type: 'memory',
      agent: 'cfo',
      kind: 'fact',
      text: longText(900),
      tags: Array.from({ length: 6 }, (_, j) => `tag-${i}-${j}`),
      source: longText(300),
      created_at: '2026-07-30T00:00:00Z',
    })),
    tasks: {
      configured: true,
      active: Array.from({ length: 15 }, (_, i) => ({
        id: `t${i}`,
        board: 'cfo',
        type: 'task',
        title: `task ${i}`,
        description: longText(600),
        owner_agent: 'cfo',
        status: 'open',
        priority: 'normal',
        tags: Array.from({ length: 6 }, (_, j) => `tag-${i}-${j}`),
        artifact_uri: null,
        created_by: 'cfo',
        created_at: '2026-07-30T00:00:00Z',
        updated_at: '2026-07-30T00:00:00Z',
        claim_ts: null,
        lease_until: null,
        lease_version: 0,
        idempotency_key: null,
        done_ts: null,
        notes: Array.from({ length: 6 }, (_, j) => `note ${i}-${j} ${longText(80)}`),
        attempt_count: 0,
      })),
      counts: { open: 5, claimed: 3, in_progress: 2 },
    },
    inbox: {
      configured: true,
      count: 8,
      preview: Array.from({ length: 5 }, (_, i) => ({
        message_id: `i${i}`,
        to: 'cfo',
        from: 'cto',
        subject: `subject ${i}`,
        body: longText(400),
        ts: '2026-07-30T00:00:00Z',
        dequeue_count: 0,
        acked: false,
      })),
    },
    inbound: {
      configured: true,
      count: 3,
      sinceMarker: '2026-07-26T00:00:00Z',
      notes: Array.from({ length: 3 }, (_, i) => ({
        id: `n${i}`,
        type: 'fact',
        text: longText(900),
        agent: 'cfo',
        by: 'cto',
        tags: [],
      })),
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
    { id: 'c3', type: 'correction', text: 'newest', supersedes: 'c2' },
    { id: 'c2', type: 'correction', text: 'middle', supersedes: 'c1' },
    { id: 'c1', type: 'correction', text: 'oldest' },
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
    { id: 'd2', type: 'decision', text: 'the real decision', supersedes: 'd1' },
    { id: 'd1', type: 'decision', text: 'the old, now-wrong decision' },
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
    { id: 'm2', type: 'memory', text: 'the corrected memory', supersedes: 'm1' },
    { id: 'm1', type: 'memory', text: 'the retracted memory' },
  ];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.memory_records.map((r: any) => r.id),
    ['m2'],
  );
});

test('buildBriefWake never drops an entry nothing supersedes', () => {
  const data = fullData();
  data.pack.corrections = [
    { id: 'a', type: 'correction', text: 'x' },
    { id: 'b', type: 'correction', text: 'y' },
  ];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.corrections.map((c: any) => c.id).sort(),
    ['a', 'b'],
  );
});

// ---- global (cross-type, cross-store) retraction, the 2026-07-30 fix --------------------------

test('buildBriefWake removes a correction that a DECISION supersedes (cross-type retraction, not just within-list)', () => {
  const data = fullData();
  data.pack.corrections = [{ id: 'c1', type: 'correction', text: 'the now-retracted correction' }];
  data.pack.decisions = [{ id: 'd1', type: 'decision', text: 'a decision that retracts c1', supersedes: 'c1' }];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.corrections.map((c: any) => c.id),
    [],
  );
  assert.deepEqual(
    brief.pack.decisions.map((d: any) => d.id),
    ['d1'],
  );
});

test('buildBriefWake removes a shared-feed fact from pack.recent when a Cosmos memory_record supersedes it (cross-store retraction)', () => {
  const data = fullData();
  data.pack.corrections = [];
  data.pack.decisions = [];
  data.pack.recent = [{ id: 'r1', type: 'fact', text: 'a fact later retracted by a Cosmos memory record' }];
  data.memory_records = [{ id: 'm1', type: 'memory', text: 'the correction, written to Cosmos', supersedes: 'r1' }];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.pack.recent.map((r: any) => r.id),
    [],
  );
});

// ---- stable id field for drill-down --------------------------------------------------------------

test('buildBriefWake keeps a stable identifier on every returned entry (corrections/decisions/memory_records/tasks use id, inbox uses the real message_id)', () => {
  const brief = buildBriefWake(fullData()) as any;
  for (const c of brief.pack.corrections) assert.equal(typeof c.id, 'string');
  for (const d of brief.pack.decisions) assert.equal(typeof d.id, 'string');
  for (const r of brief.memory_records) assert.equal(typeof r.id, 'string');
  for (const t of brief.tasks.active) assert.equal(typeof t.id, 'string');
  // ReadMessage (the real inbox.preview shape) has NO `id` field, only `message_id`.
  for (const p of brief.inbox.preview) assert.equal(typeof p.message_id, 'string');
  for (const n of brief.inbound.notes) assert.equal(typeof n.id, 'string');
});

// ---- size discipline (by VALUE SHAPE, not by a hardcoded field name) -----------------------------

test('buildBriefWake caps every long string field regardless of its name (text, description, notes[], body, source, tags[])', () => {
  const brief = buildBriefWake(fullData()) as any;
  const capSlack = M365_LITE_TEXT_CAP + 60; // truncation marker overhead
  for (const c of brief.pack.corrections) {
    assert.ok(c.text.length <= capSlack);
    assert.ok(c.source.length <= capSlack);
    assert.ok(c.tags.length <= 2, `expected tags array capped, got ${c.tags.length}`);
  }
  for (const d of brief.pack.decisions) assert.ok(d.text.length <= capSlack);
  for (const r of brief.memory_records) {
    assert.ok(r.text.length <= capSlack);
    assert.ok(r.source.length <= capSlack);
  }
  for (const t of brief.tasks.active) {
    assert.ok(t.description.length <= capSlack, `expected task description capped, got ${t.description.length}`);
    assert.ok(t.notes.length <= 2, `expected task notes[] capped, got ${t.notes.length}`);
  }
  for (const m of brief.inbox.preview) assert.ok(m.body.length <= capSlack, `expected inbox body capped, got ${m.body.length}`);
  assert.ok(brief.pack.status.text.length <= capSlack);
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

test('buildBriefWake replaces pack.recent with a small, retraction-filtered fact/pitfall subset -- NOT emptied -- and preserves pack.count', () => {
  const brief = buildBriefWake(fullData()) as any;
  assert.ok(brief.pack.recent.length > 0, 'expected a non-empty bounded recent subset');
  assert.ok(brief.pack.recent.length <= WAKE_BRIEF_RECENT_FACT_CAP);
  for (const r of brief.pack.recent) assert.ok(r.type === 'fact' || r.type === 'pitfall');
  assert.equal(brief.pack.count, 120);
});

test('buildBriefWake excludes correction/decision-typed entries from pack.recent (already covered above)', () => {
  const data = fullData();
  data.pack.recent = [
    { id: 'r1', type: 'correction', text: 'should never appear in recent' },
    { id: 'r2', type: 'fact', text: 'a real fact' },
  ];
  const rawMine = [...data.pack.corrections, ...data.pack.decisions, ...data.pack.recent];
  const brief = buildBriefWake(data, rawMine) as any;
  assert.ok(!brief.pack.recent.some((r: any) => r.id === 'r1'), 'a correction-typed entry must never appear in recent');
  assert.ok(brief.pack.recent.some((r: any) => r.id === 'r2'), 'a real fact-typed entry must still appear in recent');
});

test('buildBriefWake preserves counts (tasks.counts, inbox.count, inbound.count) even though it trims the underlying lists', () => {
  const brief = buildBriefWake(fullData()) as any;
  assert.deepEqual(brief.tasks.counts, { open: 5, claimed: 3, in_progress: 2 });
  assert.equal(brief.inbox.count, 8);
  assert.equal(brief.inbound.count, 3);
});

test('buildBriefWake strips Cosmos internal bookkeeping fields from memory_records and tasks.active', () => {
  const data = fullData();
  data.memory_records = [{ id: 'm1', type: 'memory', text: 'x', _rid: 'r', _self: 's', _etag: 'e', _attachments: 'a', _ts: 1 }];
  data.tasks.active = [{ id: 't1', type: 'task', description: 'x', _rid: 'r', _self: 's', _etag: 'e', _attachments: 'a', _ts: 1 }];
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
  // 8 decisions, 10 recent, 12 memory records, 15 tasks) each near wake's own full-mode
  // TEXT_CAP=900, which is the shape that produced the reported ~94KB in full mode.
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

// ---- round 2 (2026-07-30): status/recent/doctrine retraction gaps, recent_limit, external retraction set

test('buildBriefWake excludes a status-typed row from pack.recent (rawMine, the real handler feed, includes status alongside facts)', () => {
  const data = fullData();
  data.pack.corrections = [];
  data.pack.decisions = [];
  const rawMine = [
    { id: 's1', type: 'status', text: 'the latest status row, also present as pack.status' },
    { id: 'r1', type: 'fact', text: 'a real fact' },
  ];
  const brief = buildBriefWake(data, rawMine) as any;
  assert.ok(!brief.pack.recent.some((r: any) => r.id === 's1'), 'status must never duplicate into recent');
  assert.ok(brief.pack.recent.some((r: any) => r.id === 'r1'));
});

test('buildBriefWake drops pack.status when its id is retracted (a later fact/correction can supersede a status row)', () => {
  const data = fullData();
  data.pack.status = { id: 'st1', type: 'status', text: 'the now-stale status' };
  data.pack.corrections = [{ id: 'c1', type: 'correction', text: 'retracts the status', supersedes: 'st1' }];
  data.pack.decisions = [];
  const brief = buildBriefWake(data) as any;
  assert.equal(brief.pack.status, null);
});

test('buildBriefWake filters a retracted id out of doctrine.pitfalls too (retraction promised "across all sections")', () => {
  const data = fullData();
  data.doctrine.pitfalls = [
    { id: 'p1', text: 'a retracted pitfall', source: 'shared_feed' as const },
    { id: 'p2', text: 'a live pitfall', source: 'shared_feed' as const },
  ];
  data.pack.corrections = [{ id: 'c1', type: 'correction', text: 'retracts p1', supersedes: 'p1' }];
  data.pack.decisions = [];
  const brief = buildBriefWake(data) as any;
  assert.deepEqual(
    brief.doctrine.pitfalls.map((p: any) => p.id),
    ['p2'],
  );
});

test('buildBriefWake respects a caller recent_limit smaller than WAKE_BRIEF_RECENT_FACT_CAP', () => {
  const data = fullData();
  data.pack.corrections = [];
  data.pack.decisions = [];
  const rawMine = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: 'fact', text: `fact ${i}` }));
  const brief = buildBriefWake(data, rawMine, undefined, 1) as any;
  assert.equal(brief.pack.recent.length, 1);
});

test('buildBriefWake never exceeds WAKE_BRIEF_RECENT_FACT_CAP even when recent_limit is larger', () => {
  const data = fullData();
  data.pack.corrections = [];
  data.pack.decisions = [];
  const rawMine = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: 'fact', text: `fact ${i}` }));
  const brief = buildBriefWake(data, rawMine, undefined, 40) as any;
  assert.equal(brief.pack.recent.length, WAKE_BRIEF_RECENT_FACT_CAP);
});

test('buildBriefWake, given an externally-supplied retraction set, drops an id that set marks retracted even though nothing in the payload itself supersedes it (simulates a Cosmos-only retraction outside the visible memory_records slice)', () => {
  const data = fullData();
  data.pack.corrections = [{ id: 'c1', type: 'correction', text: 'looks live from this payload alone' }];
  data.pack.decisions = [];
  const brief = buildBriefWake(data, undefined, new Set(['c1'])) as any;
  assert.deepEqual(
    brief.pack.corrections.map((c: any) => c.id),
    [],
  );
});

test('computeRetractedIds trims whitespace around a supersedes value, matching memory/retractions.ts collectRetracted', () => {
  const ids = computeRetractedIds([{ id: 'a', supersedes: '  c1  ' }]);
  assert.ok(ids.has('c1'));
  assert.ok(!ids.has('  c1  '));
});
