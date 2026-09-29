/**
 * Regression: a `supersedes` value must retract its target whether either side is written as the RAW
 * ledger id (`20260929-9223f3c968b4`) or the lane-prefixed index doc id (`developer__20260929-9223f3c968b4`).
 * Observed live 2026-09-29: entry 20260929-d07c9c01c6ea (developer) superseded 20260929-9223f3c968b4,
 * yet brain_search kept returning the old doc (index id `developer__20260929-9223f3c968b4`) at rank #1.
 * Only behaviour through the existing exports is asserted here, so these cases run against the
 * pre-fix module too (that is how fail-on-old is proven).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRetractedByAgent, filterRetractedByAgent } from './retractions.js';

const OLD = '20260929-9223f3c968b4';

test('prefixed doc id + RAW supersedes: the old doc is dropped, the correction kept', () => {
  const by = collectRetractedByAgent([{ agent: 'developer', supersedes: OLD }]);
  const { kept, dropped } = filterRetractedByAgent(
    [
      { id: `developer__${OLD}`, agent: 'developer' },
      { id: 'developer__20260929-d07c9c01c6ea', agent: 'developer' },
    ],
    by,
  );
  assert.deepEqual(kept.map((h) => h.id), ['developer__20260929-d07c9c01c6ea']);
  assert.deepEqual(dropped, [`developer__${OLD}`]);
});

test('RAW (legacy unprefixed) doc id + PREFIXED supersedes: the old doc is dropped', () => {
  const by = collectRetractedByAgent([{ agent: 'cro', supersedes: 'cro__20260726-003-573d' }]);
  const { kept, dropped } = filterRetractedByAgent(
    [
      { id: '20260726-003-573d', agent: 'cro' },
      { id: 'cro__20260726-003-573d', agent: 'cro' },
    ],
    by,
  );
  assert.equal(kept.length, 0, 'both the bare and the prefixed copy of the retracted entry must go');
  assert.equal(dropped.length, 2);
});

test('prefixed supersedes matches regardless of case in the prefix', () => {
  const by = collectRetractedByAgent([{ agent: 'developer', supersedes: `Developer__${OLD}` }]);
  const { kept } = filterRetractedByAgent([{ id: `developer__${OLD}`, agent: 'developer' }], by);
  assert.equal(kept.length, 0);
});

test('an unrelated id is never dropped', () => {
  const by = collectRetractedByAgent([{ agent: 'developer', supersedes: OLD }]);
  const hits = [
    { id: 'developer__20260929-000000000000', agent: 'developer' },
    { id: 'cto__20260929-8c464a0349d1', agent: 'cto' },
  ];
  const { kept, dropped } = filterRetractedByAgent(hits, by);
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped, []);
});

test('a supersedes naming ANOTHER lane prefix does not retract that lane (no cross-lane widening)', () => {
  const by = collectRetractedByAgent([{ agent: 'cto', supersedes: `cfo__${OLD}` }]);
  const { kept } = filterRetractedByAgent([{ id: `cfo__${OLD}`, agent: 'cfo' }], by);
  assert.equal(kept.length, 1);
});

test('owner-less hit with a globally-unique id shape is retracted; a legacy counter id is not', () => {
  const by = collectRetractedByAgent([
    { agent: 'developer', supersedes: OLD },
    { agent: 'cto', supersedes: '20260730-001' },
  ]);
  const { kept, dropped } = filterRetractedByAgent(
    [
      { id: OLD }, // no prefix, no agent: unique hash id -> safe to match
      { id: '20260730-001' }, // legacy per-lane counter: ambiguous owner -> must stay (collision-safe)
    ],
    by,
  );
  assert.deepEqual(kept.map((h) => h.id), ['20260730-001']);
  assert.deepEqual(dropped, [OLD]);
});
