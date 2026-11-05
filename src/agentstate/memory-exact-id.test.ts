import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMemory, type MemoryRecord } from './memory.js';

const record: MemoryRecord = {
  id: 'm_test_12345678', type: 'memory', agent: 'cto', kind: 'status',
  text: 'Exact Source Record', tags: [], source: null, created_at: '2026-01-01T00:00:00Z',
};

test('exact ID reads only the requested agent partition and returns the matching record', async () => {
  const calls: Array<[string, string]> = [];
  const result = await searchMemory({ agent: 'CTO', id: record.id }, async (id, agent) => {
    calls.push([id, agent]);
    return record;
  });
  assert.deepEqual(calls, [[record.id, 'cto']]);
  assert.deepEqual(result, [record]);
});

test('an exact ID cannot become an unscoped search', async () => {
  let called = false;
  await assert.rejects(searchMemory({ id: record.id }, async () => { called = true; return record; }), /agent is required/);
  assert.equal(called, false);
});

test('an absent, wrong-ID or wrong-agent record is never substituted', async () => {
  for (const candidate of [null, { ...record, id: 'm_other' }, { ...record, agent: 'developer' }]) {
    assert.deepEqual(await searchMemory({ agent: 'cto', id: record.id }, async () => candidate), []);
  }
});

test('exact lookup retains kind and case-insensitive text filters', async () => {
  const read = async () => record;
  assert.deepEqual(await searchMemory({ agent: 'cto', id: record.id, kind: 'status', contains: 'SOURCE' }, read), [record]);
  assert.deepEqual(await searchMemory({ agent: 'cto', id: record.id, kind: 'fact' }, read), []);
  assert.deepEqual(await searchMemory({ agent: 'cto', id: record.id, contains: 'missing' }, read), []);
});
