import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteRetraction, normalizeSupersedesId, retractedIdsByAgent, __resetRetractionCache } from './retractions.js';

test('normalizeSupersedesId strips only the superseding lane\'s own prefix', () => {
  assert.equal(normalizeSupersedesId('20260929-9223f3c968b4', 'developer'), '20260929-9223f3c968b4');
  assert.equal(normalizeSupersedesId('developer__20260929-9223f3c968b4', 'developer'), '20260929-9223f3c968b4');
  assert.equal(normalizeSupersedesId('  Developer__x1 ', 'developer'), 'x1');
  assert.equal(normalizeSupersedesId('cfo__x1', 'developer'), 'cfo__x1');
  assert.equal(normalizeSupersedesId('developer__', 'developer'), 'developer__');
});

test('noteRetraction makes a just-written retraction visible without waiting for the TTL', async () => {
  __resetRetractionCache();
  await retractedIdsByAgent(); // warm the cache (stores are unconfigured in tests -> fail-open, empty)
  assert.equal((await retractedIdsByAgent()).get('developer')?.has('20260929-9223f3c968b4') ?? false, false);
  noteRetraction('developer', 'developer__20260929-9223f3c968b4');
  assert.ok((await retractedIdsByAgent()).get('developer')?.has('20260929-9223f3c968b4'));
  __resetRetractionCache();
});

test('noteRetraction is a safe no-op on a cold cache or junk input', () => {
  __resetRetractionCache();
  assert.doesNotThrow(() => noteRetraction('developer', 'x'));
  assert.doesNotThrow(() => noteRetraction(undefined, undefined));
  assert.doesNotThrow(() => noteRetraction('', ''));
});
