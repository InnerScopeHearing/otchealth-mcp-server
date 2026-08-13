import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDocId, serviceFromEndpoint, buildMemoryDoc, effectiveOneShotDeindexBudgetMs } from './search-write.js';

test('memoryDocId matches semantic.mjs docId EXACTLY (or the reindex would duplicate the doc)', () => {
  assert.equal(memoryDocId('cto', '20260714-013'), 'cto__20260714-013');
  // semantic.mjs sanitizes anything outside [A-Za-z0-9_\-=] to '_'
  assert.equal(memoryDocId('cto', 'm_mrjpkq3l_17d54eec'), 'cto__m_mrjpkq3l_17d54eec');
  assert.equal(memoryDocId('cfo', 'id with spaces/slash'), 'cfo__id_with_spaces_slash');
});

test('Cosmos ids and shared-feed ids can never collide as doc keys', () => {
  assert.notEqual(memoryDocId('cto', 'm_abc_def'), memoryDocId('cto', '20260714-013'));
});

test('serviceFromEndpoint extracts the service name', () => {
  assert.equal(serviceFromEndpoint('https://otchealth-dataroom-search.search.windows.net'), 'otchealth-dataroom-search');
  assert.equal(serviceFromEndpoint('https://otchealth-dataroom-search.search.windows.net/'), 'otchealth-dataroom-search');
  assert.equal(serviceFromEndpoint('not-a-url'), null);
  assert.equal(serviceFromEndpoint(''), null);
});

test('serviceFromEndpoint rejects a userinfo-spoofed hostname (2026-08-04, Copilot review PR #192 round 5)', () => {
  // "real.search.windows.net" here is URL *userinfo*, not the hostname -- the real hostname is
  // "attacker.example". An un-anchored-at-the-end regex match on the raw string would wrongly
  // extract "real" and mint an admin key that later gets sent to the attacker host.
  assert.equal(serviceFromEndpoint('https://real.search.windows.net@attacker.example'), null);
});

test('serviceFromEndpoint rejects a non-https scheme, never exposing the admin key over plaintext (2026-08-04, Copilot review PR #192 round 6)', () => {
  assert.equal(serviceFromEndpoint('http://otchealth-dataroom-search.search.windows.net'), null);
  // both call sites (indexMemoryNow, prepareDeindexAuth) treat a null return as fail-closed and
  // never reach the fetch that would carry the api-key header -- this is the single choke point.
});

test('effectiveOneShotDeindexBudgetMs: a fast move gets the full normal one-shot cap, never more (2026-08-04, Copilot review PR #192 round 9)', () => {
  assert.equal(effectiveOneShotDeindexBudgetMs(0), 10_000, 'an instant move must not grant deindex extra time it never had');
  assert.equal(effectiveOneShotDeindexBudgetMs(500), 10_000, 'well under the safety margin still returns the flat normal cap');
});

test('effectiveOneShotDeindexBudgetMs: a slow move shrinks the deindex budget to preserve the 60s transport margin', () => {
  // 45000 (safety ceiling) - 40000 (elapsed) = 5000, less than the normal 10000 cap.
  assert.equal(effectiveOneShotDeindexBudgetMs(40_000), 5_000);
});

test('effectiveOneShotDeindexBudgetMs: floors at 1000ms even when the move alone nearly exhausted the safety margin -- cleanup is still attempted, never silently skipped', () => {
  assert.equal(effectiveOneShotDeindexBudgetMs(44_500), 1_000);
  assert.equal(effectiveOneShotDeindexBudgetMs(999_999), 1_000, 'an absurdly slow move still floors rather than going negative');
});

test('buildMemoryDoc mirrors the semantic.mjs shape and upserts (never duplicates)', () => {
  const doc = buildMemoryDoc({ agent: 'cto', id: '20260714-013', type: 'fact', ts: '2026-07-14T05:03:13Z', tags: ['p0', 'recall'], text: 'hello', vector: [0.1, 0.2] });
  assert.equal(doc['@search.action'], 'mergeOrUpload');
  assert.equal(doc.id, 'cto__20260714-013');
  assert.equal(doc.tags, 'p0, recall');
  assert.equal(doc.text, 'hello');
  assert.deepEqual(doc.contentVector, [0.1, 0.2]);
});

test('a doc with NO vector still indexes (keyword+semantic beats nothing) — degrade, never drop', () => {
  const doc = buildMemoryDoc({ agent: 'cto', id: 'x', text: 'hello', vector: null });
  assert.ok(!('contentVector' in doc), 'must omit the vector field entirely rather than send null');
  assert.equal(doc.text, 'hello');
});

test('text is capped at 16000 chars, matching the index field limit', () => {
  const doc = buildMemoryDoc({ agent: 'cto', id: 'x', text: 'A'.repeat(20000), vector: null });
  assert.equal((doc.text as string).length, 16000);
});

test('missing optional fields degrade to empty strings, never undefined (index rejects undefined)', () => {
  const doc = buildMemoryDoc({ agent: 'cto', id: 'x', text: 't', vector: null });
  assert.equal(doc.type, '');
  assert.equal(doc.ts, '');
  assert.equal(doc.tags, '');
});
