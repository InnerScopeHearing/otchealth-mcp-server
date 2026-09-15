import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCurrentRecallHits } from './recall.js';

test('current recall removes a retired entry only from the superseding agent lane', () => {
  const hits = [
    { id: 'cto__20260915-001', agent: 'cto', text: 'retired CTO belief' },
    { id: 'cfo__20260915-001', agent: 'cfo', text: 'same bare ID, still current CFO belief' },
    { id: 'cto__20260915-002', agent: 'cto', text: 'current CTO correction' },
  ];

  const current = filterCurrentRecallHits(hits, new Map([
    ['cto', new Set(['20260915-001'])],
  ]));

  assert.deepEqual(current.map((hit) => hit.id), ['cfo__20260915-001', 'cto__20260915-002']);
});

test('current recall preserves all hits when no retraction exists', () => {
  const hits = [{ id: 'cto__current', agent: 'cto', text: 'current belief' }];
  assert.deepEqual(filterCurrentRecallHits(hits, new Map()), hits);
});
