import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseSuperseded,
  capText,
  buildDoctrinePitfalls,
  DEFINITION_OF_DONE,
  STANDING_DIRECTIVES,
} from './wake.js';
import type { MemoryEntry } from '../../memory/store.js';

const entry = (id: string, extra: Record<string, unknown> = {}): MemoryEntry =>
  ({ id, ts: '2026-07-12T00:00:00Z', type: 'correction', text: `t-${id}`, tags: [], agent: 'cto', ...extra }) as unknown as MemoryEntry;

test('collapseSuperseded drops entries referenced by a newer supersedes chain', () => {
  const newest = entry('c3', { supersedes: 'c2' });
  const middle = entry('c2', { supersedes: 'c1' });
  const oldest = entry('c1');
  const out = collapseSuperseded([newest, middle, oldest]);
  assert.deepEqual(out.map((e) => e.id), ['c3']);
});

test('collapseSuperseded keeps independent corrections and preserves order', () => {
  const a = entry('a');
  const b = entry('b');
  const out = collapseSuperseded([a, b]);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b']);
});

test('collapseSuperseded ignores non-string/absent supersedes', () => {
  const weird = entry('w', { supersedes: 42 });
  const plain = entry('p');
  assert.equal(collapseSuperseded([weird, plain]).length, 2);
});

test('capText truncates long text, flags it, and keeps the id', () => {
  const rec = { id: 'x', text: 'A'.repeat(1500) };
  const out = capText(rec, 900);
  assert.equal(out.id, 'x');
  assert.ok((out.text as string).length < 1100);
  assert.ok((out.text as string).includes('truncated'));
  assert.equal((out as Record<string, unknown>)['truncated'], true);
});

test('capText leaves short text and non-string text untouched', () => {
  const short = { id: 's', text: 'hello' };
  assert.deepEqual(capText(short, 900), short);
  const noText = { id: 'n', v: 1 };
  assert.deepEqual(capText(noText as unknown as Record<string, unknown>, 900), noText);
});

// --- supersedes is now a REAL field (fix 2026-07-13) -------------------------------------------
// Before this, MemoryEntry had no `supersedes` property and nothing could write one, so
// collapseSuperseded() was dead code: a retracted belief (e.g. the wrong daily-digest root cause
// in 20260713-015) kept surfacing as a live truth. These tests pin the behaviour now that
// memory_remember / memory_write can actually set it.

test('collapseSuperseded drops a correction that a newer typed entry supersedes', () => {
  const newer = entry('20260713-017', { supersedes: '20260713-015' });
  const stale = entry('20260713-015');
  const out = collapseSuperseded([newer, stale]);
  assert.deepEqual(out.map((e) => e.id), ['20260713-017']);
});

test('collapseSuperseded follows a multi-link chain and keeps only the surviving head', () => {
  const c = entry('c', { supersedes: 'b' });
  const b = entry('b', { supersedes: 'a' });
  const a = entry('a');
  assert.deepEqual(collapseSuperseded([c, b, a]).map((e) => e.id), ['c']);
});

test('collapseSuperseded never drops an entry nothing supersedes', () => {
  const x = entry('x', { supersedes: 'does-not-exist' });
  const y = entry('y');
  assert.deepEqual(collapseSuperseded([x, y]).map((e) => e.id).sort(), ['x', 'y']);
});

// --- collapseSuperseded generalized to id+supersedes (2026-07-15, doctrine-at-wake) -------------
// Needed so the SAME helper collapses both the shared-feed MemoryEntry rows AND Cosmos
// memory-of-record rows (a different shape: kind instead of type, created_at instead of ts) when
// building the doctrine pitfall digest. This must keep working for the original MemoryEntry usage
// above AND now also for a bare {id, supersedes} shape.

test('collapseSuperseded works over a non-MemoryEntry shape carrying only id + supersedes (Cosmos rows)', () => {
  const newer = { id: 'm2', kind: 'pitfall', text: 'the fix', supersedes: 'm1' };
  const stale = { id: 'm1', kind: 'pitfall', text: 'the old wrong belief' };
  const out = collapseSuperseded([newer, stale]);
  assert.deepEqual(out.map((e) => e.id), ['m2']);
});

// ---- DOCTRINE-AT-WAKE ------------------------------------------------------------------------

test('DEFINITION_OF_DONE is the verbatim 5-part standing doctrine', () => {
  assert.equal(
    DEFINITION_OF_DONE,
    'merged + CI green; deployed + verified; an independent live call; a ledger artifact URI; a monitor whose silence pages',
  );
  // 5 parts, semicolon-delimited, per the spec.
  assert.equal(DEFINITION_OF_DONE.split(';').length, 5);
});

test('STANDING_DIRECTIVES carries the four non-negotiables', () => {
  const joined = STANDING_DIRECTIVES.join(' | ').toLowerCase();
  assert.match(joined, /ground-first/);
  assert.match(joined, /write-through/);
  assert.match(joined, /secret value/);
  assert.match(joined, /phi/);
  assert.match(joined, /non-baa/);
});

test('STANDING_DIRECTIVES contains no em/en dashes (published-string rule)', () => {
  for (const line of STANDING_DIRECTIVES) {
    assert.ok(!line.includes('—'), `em dash in: ${line}`);
    assert.ok(!line.includes('–'), `en dash in: ${line}`);
  }
});

test('buildDoctrinePitfalls: shared-feed pitfalls take priority, both sources merge up to the cap of 8', () => {
  const shared: MemoryEntry[] = Array.from({ length: 5 }, (_, i) =>
    entry(`s${i}`, { type: 'pitfall', text: `shared pitfall ${i}` }),
  );
  const cosmos = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: `cosmos pitfall ${i}` }));
  const out = buildDoctrinePitfalls(shared, cosmos);
  assert.equal(out.length, 8, 'capped at 8 total even though 10 candidates were offered');
  assert.equal(out.filter((p) => p.source === 'shared_feed').length, 5, 'all 5 shared-feed pitfalls fit');
  assert.equal(out.filter((p) => p.source === 'memory_of_record').length, 3, 'cosmos fills only the remaining 3 slots');
});

test('buildDoctrinePitfalls: dedupes near-identical text across the two sources', () => {
  const shared: MemoryEntry[] = [entry('s1', { type: 'pitfall', text: 'do not hardcode the webhook host' })];
  const cosmos = [{ id: 'c1', text: 'do not hardcode the webhook host' }];
  const out = buildDoctrinePitfalls(shared, cosmos);
  assert.equal(out.length, 1, 'the duplicate cosmos entry must be dropped');
  assert.equal(out[0]!.source, 'shared_feed', 'the shared-feed copy wins priority');
});

test('buildDoctrinePitfalls: skips candidates with blank/missing text', () => {
  const shared: MemoryEntry[] = [
    entry('s1', { type: 'pitfall', text: '   ' }),
    entry('s2', { type: 'pitfall' }), // no text field at all in extra, base entry() sets text='t-s2'
  ];
  const out = buildDoctrinePitfalls(shared, []);
  // s1 is blank and dropped; s2 keeps its base text 't-s2'.
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 's2');
});

test('buildDoctrinePitfalls: caps each pitfall text length and flags truncation with an ellipsis', () => {
  const longText = 'x'.repeat(500);
  const shared: MemoryEntry[] = [entry('s1', { type: 'pitfall', text: longText })];
  const out = buildDoctrinePitfalls(shared, []);
  assert.ok(out[0]!.text.length < longText.length);
  assert.ok(out[0]!.text.endsWith('…'));
});

test('buildDoctrinePitfalls: empty inputs yield an empty list (no pitfalls is a valid, safe doctrine)', () => {
  assert.deepEqual(buildDoctrinePitfalls([], []), []);
});
