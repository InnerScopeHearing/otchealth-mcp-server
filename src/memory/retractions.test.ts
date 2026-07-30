import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryIdFromDocId, collectRetracted, collectRetractedByAgent, filterRetracted } from './retractions.js';

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

// ---- collectRetractedByAgent (round 3, 2026-07-30): the cross-agent bare-id collision fix -------
// Shared-feed ids are per-agent day+counter values (memory/store.ts's nextId), so two DIFFERENT
// agents can both have an entry literally named "20260730-001" on the same day. A bare, agent-less
// retraction set (collectRetracted / retractedIds) is safe for its 3 existing search-index callers
// (the agent half of a `{agent}__{entryId}` doc id is already known/checked separately by the
// caller), but NOT safe to apply directly against a single agent's own in-memory payload -- exactly
// what wake.ts/pack.ts's brief mode does. collectRetractedByAgent groups by the SUPERSEDING entry's
// own agent so a caller can look up just ITS OWN retractions.

test('collectRetractedByAgent groups retractions under the SUPERSEDING entry\'s own agent', () => {
  const byAgent = collectRetractedByAgent([
    { agent: 'cto', supersedes: '20260730-001' },
    { agent: 'cfo', supersedes: '20260730-002' },
    { agent: 'cto', supersedes: '20260730-003' },
  ]);
  assert.deepEqual([...(byAgent.get('cto') ?? [])].sort(), ['20260730-001', '20260730-003']);
  assert.deepEqual([...(byAgent.get('cfo') ?? [])].sort(), ['20260730-002']);
  assert.equal(byAgent.has('clo'), false);
});

test('THE COLLISION THIS FIXES: two agents sharing the same bare id are kept SEPARATE, not merged', () => {
  // cto's "20260730-001" is retracted; cfo ALSO has an unrelated, live "20260730-001". A bare
  // (agent-less) set would hide cfo's live entry too. The agent-scoped map must not.
  const byAgent = collectRetractedByAgent([{ agent: 'cto', supersedes: '20260730-001' }]);
  assert.ok(byAgent.get('cto')?.has('20260730-001'));
  assert.equal(byAgent.get('cfo')?.has('20260730-001') ?? false, false, "cfo's own id must never be marked retracted by cto's action");
});

test('collectRetractedByAgent ignores an entry with no agent or no supersedes', () => {
  const byAgent = collectRetractedByAgent([{ supersedes: '20260730-001' }, { agent: 'cto' }, { agent: 'cto', supersedes: '  ' }]);
  assert.equal(byAgent.size, 0);
});

test('collectRetractedByAgent trims a supersedes value, matching collectRetracted', () => {
  const byAgent = collectRetractedByAgent([{ agent: 'cto', supersedes: '  20260730-001  ' }]);
  assert.ok(byAgent.get('cto')?.has('20260730-001'));
  assert.equal(byAgent.get('cto')?.has('  20260730-001  '), false);
});
