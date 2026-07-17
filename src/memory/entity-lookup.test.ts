import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normKey,
  resolveAlias,
  currentEntity,
  matchEntity,
  lookupEntity,
  MIN_KEY_LEN,
  type EntityRow,
} from './entity-lookup.js';

const E = (ekey: string, evalue: string, ts: string, extra: Partial<EntityRow> = {}): EntityRow => ({
  type: 'entity',
  ekey,
  evalue,
  ts,
  id: `${ekey}-${ts}`,
  ...extra,
});
const AL = (from: string, to: string, ts: string): EntityRow => ({ type: 'alias', ekey: from, evalue: to, ts, id: `a-${from}` });

// ── pure key helpers (must match mem.mjs exactly) ────────────────────────────────────────────────
test('normKey collapses casing + punctuation to a token key', () => {
  assert.equal(normKey('iHEARtest Build'), 'iheartest_build');
  assert.equal(normKey('  n8n base URL '), 'n8n_base_url');
  assert.equal(normKey('ASC_Key-ID!!'), 'asc_key_id');
  assert.equal(normKey(null), '');
  assert.equal(normKey(42 as unknown), '');
});

test('currentEntity returns the LATEST-ts row for a key (superseded values never surface)', () => {
  const rows = [E('k', 'old', '2026-01-01'), E('k', 'new', '2026-07-01'), E('other', 'x', '2026-07-02')];
  assert.equal(currentEntity(rows, 'k')?.evalue, 'new');
  assert.equal(currentEntity(rows, 'missing'), null);
});

test('resolveAlias follows the chain and is cycle-safe', () => {
  assert.equal(resolveAlias([AL('a', 'b', '1'), AL('b', 'c', '1')], 'a'), 'c');
  const r = resolveAlias([AL('x', 'y', '1'), AL('y', 'x', '1')], 'x'); // must TERMINATE, not hang
  assert.ok(r === 'x' || r === 'y');
  assert.equal(resolveAlias([], 'Some Key'), 'some_key', 'no alias -> normKey(self)');
});

// ── the query -> entity resolver ─────────────────────────────────────────────────────────────────
test('matchEntity EXACT: the whole query normalizes to a key', () => {
  const rows = [E('n8n_base_url', 'https://automation.otchealth.app', '2026-07-01')];
  assert.equal(matchEntity('n8n base URL', rows)?.evalue, 'https://automation.otchealth.app');
});

test('matchEntity ALIAS: a phrasing resolves to the canonical key', () => {
  const rows = [
    E('asc_consumer_signing_key_id', '9MR7PJHRYH', '2026-07-01'),
    AL('asc_signing_key', 'asc_consumer_signing_key_id', '2026-07-01'),
  ];
  assert.equal(matchEntity('asc signing key', rows)?.evalue, '9MR7PJHRYH');
});

test('matchEntity CONTAINMENT: the LONGEST key inside a sentence wins', () => {
  const rows = [E('base_url', 'WRONG', '2026-07-01'), E('n8n_base_url', 'https://automation.otchealth.app', '2026-07-01')];
  const hit = matchEntity('what is the n8n base url', rows);
  assert.equal(hit?.ekey, 'n8n_base_url', 'the more specific key must win over the substring key');
  assert.equal(hit?.evalue, 'https://automation.otchealth.app');
});

test('matchEntity CONTAINMENT returns the LATEST value for the matched key', () => {
  const rows = [
    E('asc_consumer_signing_key_id', 'OLD', '2026-01-01'),
    E('asc_consumer_signing_key_id', '9MR7PJHRYH', '2026-07-01'),
  ];
  const hit = matchEntity('remind me of the asc consumer signing key id please', rows);
  assert.equal(hit?.evalue, '9MR7PJHRYH');
});

test('matchEntity: keys shorter than MIN_KEY_LEN never fire by containment', () => {
  assert.ok('id'.length < MIN_KEY_LEN);
  assert.equal(matchEntity('what is the id of the thing', [E('id', 'SHOULD_NOT_FIRE', '2026-07-01')]), null);
});

test('matchEntity: an unrelated query returns null (fall through to semantic recall)', () => {
  const rows = [E('n8n_base_url', 'x', '2026-07-01')];
  assert.equal(matchEntity('how do i configure the golf betting engine', rows), null);
  assert.equal(matchEntity('', rows), null);
});

test('matchEntity: a matched key with no current entity row (alias points nowhere) -> null', () => {
  const rows = [AL('dangling', 'no_such_entity', '2026-07-01')];
  assert.equal(matchEntity('dangling', rows), null);
});

// ── kill-switch ──────────────────────────────────────────────────────────────────────────────────
test('lookupEntity kill-switch: mode "off" short-circuits to null (no read)', async () => {
  assert.equal(await lookupEntity('n8n base url', 'off'), null);
  assert.equal(await lookupEntity('n8n base url', 'OFF'), null);
});
