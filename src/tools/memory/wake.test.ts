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
