import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDistillResponse } from './checkpoint.js';

test('parseDistillResponse: parses a well-formed reply', () => {
  const out = parseDistillResponse(
    JSON.stringify({ memories: [{ kind: 'fact', text: 'ASC key id is 9MR7PJHRYH' }, { kind: 'decision', text: 'ship build 46' }] }),
  );
  assert.deepEqual(out, [
    { kind: 'fact', text: 'ASC key id is 9MR7PJHRYH' },
    { kind: 'decision', text: 'ship build 46' },
  ]);
});

test('parseDistillResponse: an empty memories array parses to an empty list', () => {
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: [] })), []);
});

test('parseDistillResponse: caps at 3 items even if the model returns more', () => {
  const memories = Array.from({ length: 10 }, (_, i) => ({ kind: 'fact', text: `fact ${i}` }));
  const out = parseDistillResponse(JSON.stringify({ memories }));
  assert.equal(out.length, 3);
});

test('parseDistillResponse: drops items with an unrecognized kind', () => {
  const out = parseDistillResponse(
    JSON.stringify({ memories: [{ kind: 'status', text: 'chatter' }, { kind: 'fact', text: 'a real fact' }] }),
  );
  assert.deepEqual(out, [{ kind: 'fact', text: 'a real fact' }]);
});

test('parseDistillResponse: drops items with a missing/empty/non-string text', () => {
  const out = parseDistillResponse(
    JSON.stringify({
      memories: [
        { kind: 'fact', text: '' },
        { kind: 'fact' },
        { kind: 'fact', text: 42 },
        { kind: 'fact', text: '  ' },
        { kind: 'fact', text: 'kept' },
      ],
    }),
  );
  assert.deepEqual(out, [{ kind: 'fact', text: 'kept' }]);
});

test('parseDistillResponse: truncates an overlong text field', () => {
  const long = 'x'.repeat(3000);
  const out = parseDistillResponse(JSON.stringify({ memories: [{ kind: 'pitfall', text: long }] }));
  assert.equal(out.length, 1);
  assert.ok(out[0]!.text.length <= 2000);
});

test('parseDistillResponse: never throws on malformed JSON, missing memories key, or wrong types', () => {
  assert.deepEqual(parseDistillResponse('not json at all'), []);
  assert.deepEqual(parseDistillResponse('{}'), []);
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: 'not an array' })), []);
  assert.deepEqual(parseDistillResponse(JSON.stringify({ memories: [null, 42, 'x'] })), []);
  assert.deepEqual(parseDistillResponse(''), []);
});
