import test from 'node:test';
import assert from 'node:assert/strict';
import { filterExactSharedIdHits, parseExactSharedIdQuery } from './recall.js';

test('recognizes a whole agent-qualified shared memory ID', () => {
  assert.deepEqual(parseExactSharedIdQuery('chat_shared__20260925-4c3357980000'), {
    agent: 'chat_shared',
    id: '20260925-4c3357980000',
  });
});

test('recognizes a whole bare shared memory ID', () => {
  assert.deepEqual(parseExactSharedIdQuery('20260925-4c3357980000'), {
    agent: null,
    id: '20260925-4c3357980000',
  });
});

test('keeps natural language and ID-containing phrases on ranked recall', () => {
  assert.equal(parseExactSharedIdQuery('find 20260925-4c3357980000'), null);
  assert.equal(parseExactSharedIdQuery('what changed in CFO notes?'), null);
});

test('exact ID filtering excludes a semantically related row with a different stored ID', () => {
  const rows = [
    { id: '20260925-4c3357980000', agent: 'chat_shared', text: 'requested note' },
    { id: '20260925-4c3357980001', agent: 'chat_shared', text: 'semantically related note' },
    { id: '20260925-4c3357980000', agent: 'cto', text: 'same bare ID in another lane' },
  ];
  assert.deepEqual(filterExactSharedIdHits(rows, '20260925-4c3357980000', 'chat_shared'), [rows[0]]);
});

