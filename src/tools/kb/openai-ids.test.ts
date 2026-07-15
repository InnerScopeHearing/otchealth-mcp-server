import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompositeId, parseCompositeId } from './openai-ids.js';

test('buildCompositeId joins room and key with the "::" separator', () => {
  assert.equal(buildCompositeId('memory-exec', 'cto__142'), 'memory-exec::cto__142');
});

test('parseCompositeId round-trips buildCompositeId output', () => {
  const id = buildCompositeId('legal-personal', 'p1');
  assert.deepEqual(parseCompositeId(id), { room: 'legal-personal', key: 'p1' });
});

test('parseCompositeId splits on the FIRST "::" only, so a key containing "::" survives intact', () => {
  const id = buildCompositeId('commons-company-journal', 'path/to::weird::doc.pdf');
  assert.deepEqual(parseCompositeId(id), { room: 'commons-company-journal', key: 'path/to::weird::doc.pdf' });
});

test('parseCompositeId fails closed on a plain id with no separator', () => {
  assert.equal(parseCompositeId('just-a-plain-id'), null);
});

test('parseCompositeId fails closed on an empty room ("::key")', () => {
  assert.equal(parseCompositeId('::key'), null);
});

test('parseCompositeId fails closed on an empty key ("room::")', () => {
  assert.equal(parseCompositeId('room::'), null);
});

test('parseCompositeId fails closed on an empty string', () => {
  assert.equal(parseCompositeId(''), null);
});

test('parseCompositeId fails closed on non-string input (never throws)', () => {
  assert.equal(parseCompositeId(undefined), null);
  assert.equal(parseCompositeId(null), null);
  assert.equal(parseCompositeId(42), null);
  assert.equal(parseCompositeId({ room: 'x', key: 'y' }), null);
});

test('parseCompositeId fails closed on whitespace-only room or key', () => {
  assert.equal(parseCompositeId('   ::key'), null);
  assert.equal(parseCompositeId('room::   '), null);
});
