import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildM365LiteWake, M365_LITE_TEXT_CAP, type WakeFullData } from './wake.js';

// Pins the 2026-07-26 M365-lite wake fix: Deep Research Mode found Copilot enforces a real
// response-size ceiling (Microsoft Learn: ~25-item plugin response limit, ~4,096-token overall
// budget) independent of, and in addition to, the 2026-07-25 fix that skipped our own JIT-offload
// stub for M365 callers. buildM365LiteWake() condenses a full wake() payload for M365 static-auth
// callers specifically -- these tests pin the shape and size discipline.
//
// 2026-07-28 REWRITE: buildM365LiteWake went through FOUR field-specific patches in a row (text ->
// was -> description -> notes), each one found live in production because the fixture below didn't
// carry the field that was actually broken. A fifth review comment named the real problem: a
// field-name allowlist can never be complete. The implementation is now a generic recursive bound
// (boundValue/boundRecord in wake.ts) that caps every string and array by VALUE SHAPE regardless of
// field name. This fixture is built to be maximally adversarial on that front -- every record here
// carries fields the implementation has never seen a test for (tags, title, artifact_uri, an
// unbounded notes array), specifically so a future field can't hide the same way four already did.

function longText(n: number): string {
  return 'x'.repeat(n);
}

function longTags(n: number, len: number): string[] {
  return Array.from({ length: n }, (_, i) => `${'tag'.repeat(len)}-${i}`);
}

function fullData(overrides: Partial<WakeFullData> = {}): WakeFullData {
  return {
    agent: 'developer',
    pack: {
      configured: true,
      status: { id: 's1', text: longText(300) },
      // 'was' (a correction's prior-belief text) and 'tags' (an array capText/capField never
      // touched even after the was/description fixes) are both real fields a correction record
      // carries in production.
      corrections: Array.from({ length: 8 }, (_, i) => ({
        id: `c${i}`,
        text: longText(300),
        was: longText(300),
        tags: longTags(20, 15),
      })),
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: longText(300), was: longText(300), tags: longTags(20, 15) })),
      recent: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, text: longText(300) })),
      count: 40,
    },
    // memory_records mirror a real Cosmos document: a 'text' field, a 'tags' array, PLUS the raw
    // _rid/_self/_etag/_attachments/_ts bookkeeping fields Cosmos always attaches. Omitting any of
    // these is exactly what let each of them ship unbounded in production in turn.
    memory_records: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      text: longText(300),
      tags: longTags(20, 15),
      _rid: 'NPQiAJSeDs10BAAAAAAAAA==',
      _self: 'dbs/NPQiAA==/colls/NPQiAJSeDs0=/docs/NPQiAJSeDs10BAAAAAAAAA==/',
      _etag: '"7c0607e1-0000-0200-0000-6a5a8d020000"',
      _attachments: 'attachments/',
      _ts: 1784319234,
    })),
    tasks: {
      configured: true,
      // Real task records use 'description' for long-form content (not 'text'), carry their own
      // 'tags' array, a long 'title', a long 'artifact_uri', AND an unbounded 'notes' array that
      // task_update appends to over the task's lifetime with no length cap on the appended string.
      // Every one of these was, at some point across this file's review history, the ONE field a
      // prior fixture omitted and therefore the one that shipped unbounded.
      active: Array.from({ length: 15 }, (_, i) => ({
        id: `t${i}`,
        title: longText(200),
        description: longText(600),
        artifact_uri: longText(250),
        tags: longTags(20, 15),
        notes: [longText(400), longText(400), longText(400), longText(400), longText(400)],
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

test('buildM365LiteWake produces a raw payload comfortably under 8KB even for a maximally-adversarial wake response', () => {
  const lite = buildM365LiteWake(fullData());
  const size = Buffer.byteLength(JSON.stringify(lite), 'utf8');
  assert.ok(size < 8192, `expected under 8KB, got ${size} bytes`);
});

// THE finding from the 3rd review round on this PR (2026-07-28): the size assertion above only
// measures the raw minified object, but the ACTUAL wire response (registry.ts's buildTextContent +
// the structuredContent field) duplicates this data TWICE -- once PRETTY-PRINTED (JSON.stringify(...,
// null, 2), which costs real extra bytes for indentation) inside content[0].text, and again as the
// raw object in structuredContent.result. A test that only checks the minified single copy can pass
// while the actual emitted MCP response is meaningfully larger and still over M365's ceiling -- this
// is genuinely the gap that made "the unit test is green" an unreliable signal across every prior
// round of this bug, and is why every fix in this file's history had to be re-verified against the
// LIVE gateway before being trusted. This test closes that gap by constructing the same envelope
// shape registry.ts actually emits and asserting on ITS combined size.
test('buildM365LiteWake payload, in the ACTUAL wire envelope shape (pretty-printed text + duplicated structuredContent), stays well under the M365 response ceiling', () => {
  const lite = buildM365LiteWake(fullData());
  // Mirrors registry.ts's buildTextContent(): JSON.stringify(data, null, 2), i.e. pretty-printed.
  const contentText = JSON.stringify(lite, null, 2);
  // Mirrors registry.ts's structuredContent: { result: <data>, compliance_warning: null,
  // correlation_id: <string>, dry_run: <bool> } -- the result is the SAME object, duplicated.
  const structuredContent = { result: lite, compliance_warning: null, correlation_id: 'c'.repeat(36), dry_run: false };
  const totalBytes = Buffer.byteLength(contentText, 'utf8') + Buffer.byteLength(JSON.stringify(structuredContent), 'utf8');
  // Generous headroom under Microsoft's documented ~4,096-token ceiling (roughly 16-20K chars for
  // typical JSON/English mixed content) -- the earlier "<8KB single minified copy" target undercounted
  // by roughly 2x once the real envelope's duplication + pretty-print overhead is included.
  assert.ok(totalBytes < 16384, `expected the full wire envelope under 16KB, got ${totalBytes} bytes`);
});

test('buildM365LiteWake caps the "was" field on corrections/decisions the same way it caps "text"', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const arr of [lite.pack.corrections, lite.pack.decisions]) {
    for (const rec of arr) {
      assert.ok(rec.was.length <= M365_LITE_TEXT_CAP + 40, `expected was field capped, got ${rec.was.length} chars: ${rec.was}`);
    }
  }
});

test('buildM365LiteWake caps the "description" field on tasks.active the same way it caps "text"', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const t of lite.tasks.active) {
    assert.ok(t.description.length <= M365_LITE_TEXT_CAP + 40, `expected description capped, got ${t.description.length} chars: ${t.description}`);
  }
});

// Generic-bound regression: fields NO prior patch ever named (title, artifact_uri) are capped too,
// purely because they're strings over the cap -- proving the fix is no longer a field-name allowlist.
test('buildM365LiteWake caps arbitrary long string fields it has never been told about by name (title, artifact_uri)', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const t of lite.tasks.active) {
    assert.ok(t.title.length <= M365_LITE_TEXT_CAP + 40, `expected title capped, got ${t.title.length} chars`);
    assert.ok(t.artifact_uri.length <= M365_LITE_TEXT_CAP + 40, `expected artifact_uri capped, got ${t.artifact_uri.length} chars`);
  }
});

// The review finding that forced the rewrite: 'tags' is an unbounded array capText/capField (scalar-
// field-only) could never touch, on BOTH memory_records and tasks.active.
test('buildM365LiteWake bounds "tags" arrays (a field the old scalar-field caps could never reach) to a small item count, each item capped', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const rec of [...lite.memory_records, ...lite.tasks.active]) {
    assert.ok(rec.tags.length <= 2, `expected tags array bounded to <=2 items, got ${rec.tags.length}`);
    for (const tag of rec.tags) assert.ok(tag.length <= M365_LITE_TEXT_CAP + 40, `expected each tag capped, got ${tag.length} chars`);
  }
});

// 'notes' is a string[] that task_update appends unrestricted, unbounded-length strings to over a
// task's lifetime (task-update.ts's `note` input has no length cap). The generic bound now caps the
// ARRAY LENGTH and each STRING inside it (rather than dropping it to [] as an earlier, field-specific
// patch on this same PR did) -- verifying both halves of that bound here.
test('buildM365LiteWake bounds tasks.active[].notes (array length AND each string inside it), rather than either leaving it unbounded or dropping it silently', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  for (const t of lite.tasks.active) {
    assert.ok(t.notes.length <= 2, `expected notes array bounded to <=2 items, got ${t.notes.length}`);
    for (const note of t.notes) assert.ok(note.length <= M365_LITE_TEXT_CAP + 40, `expected each note capped, got ${note.length} chars`);
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

test('buildM365LiteWake caps corrections/decisions/memory_records/tasks.active to 2 items each', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.equal(lite.pack.corrections.length, 2);
  assert.equal(lite.pack.decisions.length, 2);
  assert.equal(lite.memory_records.length, 2);
  assert.equal(lite.tasks.active.length, 2);
});

test('buildM365LiteWake drops recent/preview/notes entirely at the pack/inbox/inbound level (biggest size contributors)', () => {
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

test('buildM365LiteWake caps doctrine pitfalls to 3 but keeps definition_of_done and standing_directives intact', () => {
  const lite = buildM365LiteWake(fullData()) as any;
  assert.equal(lite.doctrine.pitfalls.length, 3);
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
