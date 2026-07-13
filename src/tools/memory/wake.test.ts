import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseSuperseded, capText } from './wake.js';
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
