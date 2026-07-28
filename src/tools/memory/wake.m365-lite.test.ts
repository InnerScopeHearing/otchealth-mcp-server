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
    memory_records: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: longText(300) })),
    tasks: {
      configured: true,
      active: Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, text: longText(600) })),
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
