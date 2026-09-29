import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactSharedIdQuery, resolveExactSharedId } from './recall.js';

test('recognizes the observed ID plus one unique marker token', () => {
  assert.deepEqual(parseExactSharedIdQuery('20260929-b7db22bc47ea COO-CHAT-20260929-01'), {
    agent: null,
    id: '20260929-b7db22bc47ea',
    marker: 'COO-CHAT-20260929-01',
  });
});

test('recognizes an agent-qualified ID plus marker', () => {
  assert.deepEqual(parseExactSharedIdQuery('chat_shared__20260925-4c3357980000 COO-CHAT-20260929-01'), {
    agent: 'chat_shared',
    id: '20260925-4c3357980000',
    marker: 'COO-CHAT-20260929-01',
  });
});

test('recognizes current and legacy bare ID forms', () => {
  assert.deepEqual(parseExactSharedIdQuery('20260925-4c3357980000'), {
    agent: null,
    id: '20260925-4c3357980000',
    marker: null,
  });
  assert.deepEqual(parseExactSharedIdQuery('20260619-014 CTO-CHAT-20260929-01'), {
    agent: null,
    id: '20260619-014',
    marker: 'CTO-CHAT-20260929-01',
  });
});

test('keeps natural-language phrases containing a stored ID on ranked recall', () => {
  assert.equal(parseExactSharedIdQuery('Find 20260929-b7db22bc47ea COO-CHAT-20260929-01'), null);
  assert.equal(parseExactSharedIdQuery('20260929-b7db22bc47ea what happened?'), null);
  assert.equal(parseExactSharedIdQuery('20260929-b7db22bc47ea details'), null);
  assert.equal(parseExactSharedIdQuery('what changed in CFO notes?'), null);
});

test('bare ID plus agent filter reads only that agent feed', async () => {
  const rows = [
    { id: '20260925-4c3357980000', agent: 'chat_shared', text: 'requested note' },
    { id: '20260925-4c3357980001', agent: 'chat_shared', text: 'semantically related note' },
    { id: '20260925-4c3357980000', agent: 'cto', text: 'same bare ID in another lane' },
  ];
  const readAgents: Array<string | null> = [];
  const exactId = parseExactSharedIdQuery('20260925-4c3357980000')!;
  const result = await resolveExactSharedId(exactId, 'chat_shared', async (agent) => {
    readAgents.push(agent);
    return rows.filter((row) => row.agent === agent);
  });
  assert.deepEqual(readAgents, ['chat_shared']);
  assert.deepEqual(result, { handled: true, matches: [rows[0]] });
});

test('an exact miss is handled as empty and does not request fallback candidates', async () => {
  let reads = 0;
  const exactId = parseExactSharedIdQuery('20260925-4c3357980000 CFO-CHAT-20260929-01')!;
  const result = await resolveExactSharedId(exactId, null, async () => {
    reads++;
    return [{ id: '20260925-4c3357980001', agent: 'chat_shared' }];
  });
  assert.equal(reads, 1);
  assert.deepEqual(result, { handled: true, matches: [] });
});
