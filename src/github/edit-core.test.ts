import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStrEdit, assertShaMatch, makeEditPreview } from './edit-core.js';

test('planStrEdit: exact-once match returns the replaced text', () => {
  const { next, matches } = planStrEdit('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  assert.equal(matches, 1);
  assert.equal(next, 'const a = 1;\nconst b = 3;\n');
});

test('planStrEdit: zero matches throws (fail loud, do not guess)', () => {
  assert.throws(() => planStrEdit('hello world', 'nope', 'x'), /old_str not found/);
});

test('planStrEdit: multiple matches throws unless replace_all, and lists the count', () => {
  assert.throws(() => planStrEdit('x x x', 'x', 'y'), /matches 3 times/);
});

test('planStrEdit: replace_all replaces every occurrence', () => {
  const { next, matches } = planStrEdit('x x x', 'x', 'y', true);
  assert.equal(matches, 3);
  assert.equal(next, 'y y y');
});

test('planStrEdit: replacement is LITERAL ($ patterns are not interpreted)', () => {
  // String.replace would turn `$&` into the matched text; join must insert it verbatim.
  const { next } = planStrEdit('value = OLD;', 'OLD', '$& $1 $$');
  assert.equal(next, 'value = $& $1 $$;');
});

test('planStrEdit: empty old_str is rejected', () => {
  assert.throws(() => planStrEdit('abc', '', 'x'), /old_str is empty/);
});

test('assertShaMatch: mismatch refuses, match/absent passes', () => {
  assert.throws(() => assertShaMatch('f.ts', 'aaaaaaaa1111', 'bbbbbbbb2222'), /has changed/);
  assert.doesNotThrow(() => assertShaMatch('f.ts', 'same-sha', 'same-sha'));
  assert.doesNotThrow(() => assertShaMatch('f.ts', 'whatever')); // no expected_sha -> no check
});

test('makeEditPreview: shows removed and added lines', () => {
  const text = 'line1\nline2\nTARGET\nline4\n';
  const preview = makeEditPreview(text, 'TARGET', 'REPLACED');
  assert.match(preview, /- TARGET/);
  assert.match(preview, /\+ REPLACED/);
});
