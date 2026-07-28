import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildM365LiteWake, M365_LITE_TEXT_CAP, type WakeFullData } from './wake.js';

// Pins the 2026-07-26 M365-lite wake fix: Deep Research Mode found Copilot enforces a real
// response-size ceiling (Microsoft Learn: ~25-item plugin response limit, ~4,096-token overall
// budget) independent of, and in addition to, the 2026-07-25 fix that skipped our own JIT-offload
// stub for M365 callers. buildM365LiteWake() condenses a full wake() payload for M365 static-auth
// callers specifically -- these tests pin the shape and size discipline.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function fullData(overrides: Partial<WakeFullData> = {}): WakeFullData {
  return {
    agent: 'developer',
    pack: {
      configured: true,
      status: { id: 's1', text: longText(300) },
      // 'was' is a REAL field a correction record carries in production (the prior belief being
      // corrected) -- see buildM365LiteWake's 2026-07-28 header comment. Omitting it here is
      // exactly what let the original size bug ship invisibly; every correction below carries one.
      corrections: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, text: longText(300), was: longText(300) })),
      // Decisions can carry a 'was' field too (a decision that reverses a prior one) -- covered
      // here so the "was" cap is pinned for BOTH arrays, not just corrections (a 2026-07-28 review
      // finding: the original version of this fixture/test only covered corrections, so a future
      // regression that stopped capping 'was' on decisions specifically would still pass).
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: longText(300), was: longText(300) })),
      recent: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: longText(300) })),
      count: 40,
    },
    // memory_records mirror a real Cosmos document: a 'text' field (capped) PLUS the raw
    // _rid/_self/_etag/_attachments/_ts bookkeeping fields Cosmos always attaches. Omitting these
    // (as the pre-2026-07-28-pass-2 fixture did) is exactly what let them ship unstripped in
    // production -- pure noise bytes with zero value to an M365 caller.
    memory_records: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      text: longText(300),
      _rid: 'NPQiAJSeDs10BAAAAAAAAA==',
      _self: 'dbs/NPQiAA==/colls/NPQiAJSeDs0=/docs/NPQiAJSeDs10BAAAAAAAAA==/',
      _etag: '"7c0607e1-0000-0200-0000-6a5a8d020000"',
      _attachments: 'attachments/',
      _ts: 1784319234,
    })),
    tasks: {
      configured: true,
      // Real task records use 'description', NOT 'text' -- the field name the pre-2026-07-28-pass-2
      // fixture used here. That mismatch is exactly what let a real task's description ship
      // completely uncapped in production while this fixture's "text" field (which no real task
      // record even has) was dutifully capped, masking the bug. Also carries the same Cosmos
      // bookkeeping fields as memory_records.
      active: Array.from({ length: 15 }, (_, i) => ({
        id: `t${i}`,
        title: `Task ${i}`,
        description: longText(600),
        // 'notes' is a string[] that task_update appends unrestricted, unbounded-length strings to
        // over a task's lifetime (a 2026-07-28 review finding on THIS pr) -- accumulated notes on a
        // long-lived task are a realistic size contributor this fixture omitted until now.
        notes: [longText(400), longText(400), longText(400)],
        _rid: 'NPQiAPsOhbAVAAAAAAAAAA==',
        _self: 'dbs/NPQiAA==/colls/NPQiAPsOhbA=/docs/NPQiAPsOhbAVAAAAAAAAAA==/',
        _etag: '"2f03909b-0000-0200-0000-6a57d9070000"',
        _attachments: 'attachments/',
        _ts: 1784142087,
      })),
      counts: { open: 5, claimed: 3 },
    },
    inbox: { configured: true, count: 8, preview: Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, text: longText(400) })) },
    inbound: { configured: true, count: 3, sinceMarker: '2026-07-26T00:00:00Z', notes: Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, text: longText(300) })) },
    errors: [],
    doctrine: {
      definition_of_done: 'merged + CI green; deployed + verified; an independent live call; a ledger artifact URI; a monitor whose silence pages',
      pitfalls: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, text: longText(220), source: 'shared_feed' as const })),
      standing_directives: ['a', 'b', 'c', 'd'],
    },
    ...overrides,
  };
}

test('buildM365LiteWake produces a payload comfortably under 8KB even for a maximally-full wake response', () => {
  const lite = buildM365LiteWake(fullData());
  const size = Buffer.byteLength(JSON.stringify(lite), 'utf8');
  assert.ok(size < 8192, `expected under 8KB, got ${size} bytes`);
});

// Pins the 2026-07-28 fix directly: a correction's 'was' field must be capped exactly like 'text' is
// -- this is the field the original bug left completely uncapped (capText only ever touched 'text'),
// which is what pushed a real production wake() response to ~12.6KB despite this same "<8KB" test
// passing throughout, because the OLD fixture above never included a 'was' field at all.
test('buildM365LiteWake caps the "was" field on corrections/decisions the same way it caps "text"', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  // Both arrays checked (2026-07-28 review finding: the original version of this test only looped
  // over corrections, so a future regression that stopped capping "was" on decisions specifically
  // would still have passed).
  for (const arr of [lite.pack.corrections, lite.pack.decisions]) {
    for (const rec of arr) {
      // capField appends a "…[truncated N chars]" suffix, so allow a small margin over the raw cap.
      assert.ok(rec.was.length <= M365_LITE_TEXT_CAP + 40, `expected was field capped, got ${rec.was.length} chars: ${rec.was}`);
    }
  }
});

// Pins the SECOND 2026-07-28 fix, found by re-measuring the LIVE gateway after deploying the first
// one: it barely shrank the real response (~24.3KB vs ~24.5KB before), proving the "was" fix alone
// did not actually resolve Matt's reported symptom. A task's "description" field is the same kind
// of unbounded text as "text"/"was", just under a field name capLite never checked.
test('buildM365LiteWake caps the "description" field on tasks.active the same way it caps "text"', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const t of lite.tasks.active) {
    assert.ok(t.description.length <= M365_LITE_TEXT_CAP + 40, `expected description capped, got ${t.description.length} chars: ${t.description}`);
  }
});

test('buildM365LiteWake strips Cosmos-internal bookkeeping fields (_rid/_self/_etag/_attachments/_ts) from memory_records and tasks.active', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const rec of [...lite.memory_records, ...lite.tasks.active]) {
    for (const internalField of ['_rid', '_self', '_etag', '_attachments', '_ts']) {
      assert.ok(!(internalField in rec), `expected ${internalField} to be stripped, record still has it: ${JSON.stringify(rec)}`);
    }
  }
});

// Pins a review finding on THIS pr: task_update appends unrestricted, unbounded-length strings to
// a task's 'notes' array over its lifetime (task-update.ts's `note` input has no length cap), and
// capLite only handles scalar string fields -- an array was never covered by the text/was/
// description caps. A single long-lived, heavily-annotated task could still push wake() back over
// the M365 limit even with description now capped, so notes is dropped entirely on the lite path.
test('buildM365LiteWake drops tasks.active[].notes entirely (an unbounded string[] the scalar-field caps cannot touch)', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const t of lite.tasks.active) {
    assert.deepEqual(t.notes, [], `expected notes dropped, got: ${JSON.stringify(t.notes)}`);
  }
});

test('buildM365LiteWake keeps field names/shapes identical to the full response (no outputSchema violation)', () => {
  const lite = buildM365LiteWake(fullData()) as Record<string, unknown>;
  assert.equal(typeof lite.agent, 'string');
  assert.equal(typeof lite.pack, 'object');
  assert.ok(Array.isArray(lite.memory_records));
  assert.equal(typeof lite.tasks, 'object');
  assert.equal(typeof lite.inbox, 'object');
  assert.equal(typeof lite.inbound, 'object');
  assert.ok(Array.isArray(lite.errors));
  assert.equal(typeof lite.doctrine, 'object');
});

test('buildM365LiteWake caps corrections/decisions/memory_records/tasks.active to 3 items each', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.equal(lite.pack.corrections.length, 3);
  assert.equal(lite.pack.decisions.length, 3);
  assert.equal(lite.memory_records.length, 3);
  assert.equal(lite.tasks.active.length, 3);
});

test('buildM365LiteWake drops recent/preview/notes entirely (biggest size contributors)', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.deepEqual(lite.pack.recent, []);
  assert.deepEqual(lite.inbox.preview, []);
  assert.deepEqual(lite.inbound.notes, []);
});

test('buildM365LiteWake preserves counts (count/counts/count fields) even though it drops the underlying lists', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.equal(lite.pack.count, 40);
  assert.deepEqual(lite.tasks.counts, { open: 5, claimed: 3 });
  assert.equal(lite.inbox.count, 8);
  assert.equal(lite.inbound.count, 3);
});

test('buildM365LiteWake caps doctrine pitfalls to 4 (half of the full 8-cap) but keeps definition_of_done and standing_directives intact', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.equal(lite.doctrine.pitfalls.length, 4);
  assert.equal(lite.doctrine.definition_of_done, fullData().doctrine.definition_of_done);
  assert.deepEqual(lite.doctrine.standing_directives, ['a', 'b', 'c', 'd']);
});

test('buildM365LiteWake handles a null pack.status without throwing', () => {
  const data = fullData();
  data.pack.status = null;
  const lite = buildM365LiteWake(data) as any;
  assert.equal(lite.pack.status, null);
});

test('buildM365LiteWake on an unconfigured/empty wake (new agent, nothing set up yet) stays tiny and well-formed', () => {
  const data = fullData({
    pack: { configured: false, status: null, corrections: [], decisions: [], recent: [], count: 0 },
    memory_records: [],
    tasks: { configured: false, active: [], counts: {} },
    inbox: { configured: false, count: 0, preview: [] },
    inbound: { configured: false, count: 0, sinceMarker: '', notes: [] },
    doctrine: { definition_of_done: 'x', pitfalls: [], standing_directives: [] },
  });
  const lite = buildM365LiteWake(data) as any;
  assert.equal(lite.pack.configured, false);
  const size = Buffer.byteLength(JSON.stringify(lite), 'utf8');
  assert.ok(size < 1000);
});
