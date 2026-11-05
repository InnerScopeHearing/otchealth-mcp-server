import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchAuthorizedMemory } from './memory-search.js';

test('an exact ID with no agent reads only the caller partition', async () => {
  for (const caller of ['cto', 'cfo']) {
    let observed: { agent?: string; id?: string } | undefined;
    const result = await searchAuthorizedMemory({ id: 'm_test_12345678' }, caller, async (filter) => {
      observed = filter;
      return [];
    });
    assert.equal(result.count, 0);
    assert.equal(observed?.agent, caller);
    assert.equal(observed?.id, 'm_test_12345678');
  }
});

test('a restricted agent is rejected before any exact lookup', async () => {
  let calls = 0;
  const result = await searchAuthorizedMemory({ agent: 'cfo', id: 'm_test_12345678' }, 'cto', async () => {
    calls++;
    return [];
  });
  assert.equal(result.blocked, true);
  assert.equal(calls, 0);
});

test('an explicit allowed agent is retained and its results are returned', async () => {
  let seen: string | undefined;
  const result = await searchAuthorizedMemory({ agent: 'developer', id: 'm_test_12345678' }, 'cto', async (filter) => {
    seen = filter.agent;
    return [];
  });
  assert.equal(seen, 'developer');
  assert.equal(result.blocked, undefined);
});
