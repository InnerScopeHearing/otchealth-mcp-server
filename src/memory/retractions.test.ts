import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryIdFromDocId, collectRetracted, filterRetracted } from './retractions.js';

test('entryIdFromDocId recovers the entry id from the agent-prefixed doc id', () => {
  assert.equal(entryIdFromDocId('cto__20260713-015'), '20260713-015');
  assert.equal(entryIdFromDocId('cto__m_mrjpkq3l_17d54eec'), 'm_mrjpkq3l_17d54eec');
  assert.equal(entryIdFromDocId('no-prefix'), 'no-prefix');
  assert.equal(entryIdFromDocId(undefined), '');
  assert.equal(entryIdFromDocId(42), '');
});

test('collectRetracted gathers every superseded id, ignoring junk', () => {
  const set = collectRetracted([
    { supersedes: '20260713-015' },
    { supersedes: '  20260713-002  ' }, // trimmed
    { supersedes: '' },
    { supersedes: 42 },
    {},
  ]);
  assert.deepEqual([...set].sort(), ['20260713-002', '20260713-015']);
});

test('THE LIVE BUG: a retracted belief is dropped, and its correction survives', () => {
  // Exactly what brain_search returned on 2026-07-13: the WRONG config-drift belief at rank #1,
  // and the correction that supersedes it buried further down.
  const hits = [
    { id: 'cto__20260713-015', text: 'ROOT CAUSE = config drift' }, // retracted
    { id: 'cto__20260713-017', text: 'ROOT CAUSE = cfo-store managed identity' }, // the truth
  ];
  const { kept, dropped } = filterRetracted(hits, new Set(['20260713-015']));
  assert.deepEqual(kept.map((h) => h.id), ['cto__20260713-017']);
  assert.deepEqual(dropped, ['20260713-015']);
});

test('a retraction in ONE store silences the belief regardless of which store held it', () => {
  const hits = [{ id: 'cto__m_cosmos_rec' }, { id: 'cto__20260714-013' }];
  const { kept } = filterRetracted(hits, new Set(['m_cosmos_rec']));
  assert.deepEqual(kept.map((h) => h.id), ['cto__20260714-013']);
});

test('nothing is dropped when there are no retractions (hot path stays untouched)', () => {
  const hits = [{ id: 'a__1' }, { id: 'b__2' }];
  const { kept, dropped } = filterRetracted(hits, new Set());
  assert.equal(kept, hits, 'must return the SAME array reference when there is nothing to filter');
  assert.deepEqual(dropped, []);
});

test('a hit with no id is never dropped (fail-open: never hide something we cannot identify)', () => {
  const { kept } = filterRetracted([{ id: undefined }, { id: '' }], new Set(['x']));
  assert.equal(kept.length, 2);
});
