import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normKey,
  resolveAlias,
  currentEntity,
  matchEntity,
  matchCurrentQuestion,
  activeEntityRows,
  lookupEntity,
  MIN_KEY_LEN,
  EXACT_MATCH_ONLY_TAG,
  CURRENT_VALUE_TAG,
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
const AL = (from: string, to: string, ts: string, extra: Partial<EntityRow> = {}): EntityRow => ({ type: 'alias', ekey: from, evalue: to, ts, id: `a-${from}`, ...extra });

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

test('matchEntity EXACT honors an exact-match-only alias', () => {
  const phrase = 'what_is_the_current_search_backend_for_brain_search';
  const rows = [
    E('otchealth_brain_backend', 'Amazon OpenSearch Service', '2026-09-07'),
    AL(phrase, 'otchealth_brain_backend', '2026-09-07', { tags: [EXACT_MATCH_ONLY_TAG] }),
  ];
  assert.equal(
    matchEntity('what is the current search backend for brain_search', rows)?.ekey,
    'otchealth_brain_backend',
  );
});

test('matchEntity CONTAINMENT skips an exact-match-only alias inside a historical query', () => {
  const phrase = 'what_is_the_current_search_backend_for_brain_search';
  const rows = [
    E('otchealth_brain_backend', 'Amazon OpenSearch Service', '2026-09-07'),
    AL(phrase, 'otchealth_brain_backend', '2026-09-07', { tags: 'current-value,exact-match-only' }),
  ];
  assert.equal(
    matchEntity(`historically, ${phrase}, and what did it replace?`, rows),
    null,
  );
});

test('latest exact-match-only correction disables containment from an older untagged alias row', () => {
  const phrase = 'where_is_the_otchealth_gateway_running_now';
  const rows = [
    E('otchealth_gateway_runtime', 'AWS ECS', '2026-09-07'),
    AL(phrase, 'otchealth_gateway_runtime', '2026-09-06'),
    AL(phrase, 'otchealth_gateway_runtime', '2026-09-07', { tags: [EXACT_MATCH_ONLY_TAG] }),
  ];
  assert.equal(matchEntity(`historically ${phrase} before AWS`, rows), null);
  assert.equal(matchEntity(phrase, rows)?.evalue, 'AWS ECS');
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


// ── compositional current-state questions (no sentence aliases) ─────────────────────────────────
const CURRENT_INFRA: EntityRow[] = [
  E('otchealth_primary_cloud', 'cloud-now', '2026-09-07', {
    agent: 'cto', source: 'cloud witness', tags: [CURRENT_VALUE_TAG],
  }),
  E('otchealth_gateway_runtime', 'gateway-now', '2026-09-07', {
    agent: 'cto', source: 'runtime witness', tags: [CURRENT_VALUE_TAG],
  }),
  E('otchealth_brain_backend', 'brain-now', '2026-09-07', {
    agent: 'cto', source: 'search witness', tags: [CURRENT_VALUE_TAG],
  }),
  E('otchealth_agent_state_backend', 'state-now', '2026-09-07', {
    agent: 'cto', source: 'state witness', tags: [CURRENT_VALUE_TAG],
  }),
];

test('held-out current paraphrases compose from entity key concepts instead of sentence aliases', () => {
  const cases = [
    ['Where does OTCHealth keep its current shared AI memory and search state today?', 'otchealth_brain_backend'],
    ["Which service currently powers OTCHealth's shared knowledge search?", 'otchealth_brain_backend'],
    ['Today, what runs the OTCHealth MCP gateway?', 'otchealth_gateway_runtime'],
    ['Which cloud estate is active for OTCHealth now?', 'otchealth_primary_cloud'],
    ['Where is OTCHealth hosted now?', 'otchealth_primary_cloud'],
    ['What cloud provider is currently used by OTCHealth?', 'otchealth_primary_cloud'],
    ['Where do our agent checkpoints persist currently?', 'otchealth_agent_state_backend'],
    ['What engine powers our Brain search today?', 'otchealth_brain_backend'],
  ] as const;
  for (const [query, expected] of cases) {
    const hit = matchCurrentQuestion(query, CURRENT_INFRA);
    assert.equal(hit?.ekey, expected, query);
    assert.equal(hit?.matchedBy, 'current-question', query);
    assert.equal(hit?.owner, 'cto', query);
    assert.ok(hit?.source, query);
  }
});

test('historical questions never promote a current entity, including an embedded canonical key', () => {
  const queries = [
    'Historically, where did OTCHealth keep its shared AI memory and search state before AWS?',
    'What backend did the Brain use before its current one?',
    'Previously, which cloud estate was active for OTCHealth?',
    'Which cloud did OTCHealth use before today?',
    'Which cloud used to host OTCHealth, compared with now?',
    'Historically, what did otchealth_brain_backend use?',
  ];
  for (const query of queries) assert.equal(matchEntity(query, CURRENT_INFRA), null, query);
});

test('general current inference requires the typed tag, CTO ownership, and provenance', () => {
  const query = 'What engine powers the OTCHealth Brain search today?';
  assert.equal(matchCurrentQuestion(query, [
    E('otchealth_brain_backend', 'x', '1', { agent: 'cto', source: 'witness' }),
  ]), null, 'missing current-value tag');
  assert.equal(matchCurrentQuestion(query, [
    E('otchealth_brain_backend', 'x', '1', { agent: 'coo', source: 'witness', tags: [CURRENT_VALUE_TAG] }),
  ]), null, 'wrong entity owner');
  assert.equal(matchCurrentQuestion(query, [
    E('otchealth_brain_backend', 'x', '1', { agent: 'cto', tags: [CURRENT_VALUE_TAG] }),
  ]), null, 'missing provenance');
});

test('general current inference fails closed on broad scope and ambiguous typed entities', () => {
  assert.equal(matchCurrentQuestion('Which cloud is active now?', CURRENT_INFRA), null, 'generic cloud question');
  assert.equal(matchCurrentQuestion('What engine powers the Brain search today?', CURRENT_INFRA), null,
    'a subsystem word alone is not company authorization');
  assert.equal(matchCurrentQuestion("What currently powers Acme's AI brain?", CURRENT_INFRA), null,
    'a foreign company target cannot promote an OTCHealth entity');
  assert.equal(matchCurrentQuestion(
    'What is the current agent state backend for another company?',
    CURRENT_INFRA,
  ), null, 'bare company plus strong subsystem cannot authorize promotion');
  assert.equal(matchCurrentQuestion(
    'Compare our current Brain backend with their system',
    CURRENT_INFRA,
  ), null, 'comparison and foreign target cues fail closed even with self scope');
  assert.equal(matchCurrentQuestion('What is the current customer support backend?', CURRENT_INFRA), null);
  const ambiguous = [
    ...CURRENT_INFRA,
    E('otchealth_brain_search_backend', 'other', '2026-09-08', {
      agent: 'cto', source: 'other witness', tags: [CURRENT_VALUE_TAG],
    }),
  ];
  assert.equal(
    matchCurrentQuestion('What engine powers the OTCHealth Brain search today?', ambiguous),
    null,
    'equal concept coverage must not guess',
  );
});

test('activeEntityRows applies supersedes per owner, so bare-id collisions do not cross lanes', () => {
  const rows: EntityRow[] = [
    E('otchealth_brain_backend', 'cto-old', '1', { id: 'same-id', agent: 'cto' }),
    E('coo_process_backend', 'coo-live', '1', { id: 'same-id', agent: 'coo' }),
    { type: 'correction', id: 'new-id', ts: '2', agent: 'cto', supersedes: 'same-id' },
  ];
  const active = activeEntityRows(rows);
  assert.equal(active.some((row) => row.agent === 'cto' && row.id === 'same-id'), false);
  assert.equal(active.some((row) => row.agent === 'coo' && row.id === 'same-id'), true);
});

test('activeEntityRows retains the replacement and removes the row it supersedes', () => {
  const rows: EntityRow[] = [
    E('otchealth_brain_backend', 'old', '1', { id: 'old-id', agent: 'cto' }),
    E('otchealth_brain_backend', 'new', '2', {
      id: 'new-id', agent: 'cto', supersedes: 'old-id',
    }),
  ];
  const active = activeEntityRows(rows);
  assert.deepEqual(active.map((row) => row.id), ['new-id']);
  assert.equal(matchEntity('otchealth_brain_backend', active)?.evalue, 'new');
});


test('memory-of-record retractions filter entity and alias rows without cross-lane ID collisions', () => {
  const rows: EntityRow[] = [
    E('otchealth_brain_backend', 'cto-row', '1', {
      id: 'same-id', agent: 'cto', source: 'witness', tags: [CURRENT_VALUE_TAG],
    }),
    E('coo_process_backend', 'coo-row', '1', { id: 'same-id', agent: 'coo' }),
    AL('brain_alias', 'otchealth_brain_backend', '1', { id: 'alias-id', agent: 'cto' }),
  ];
  const memoryOfRecord = new Map([
    ['cto', new Set(['same-id', 'alias-id'])],
  ]);
  const active = activeEntityRows(rows, memoryOfRecord);
  assert.equal(active.some((row) => row.agent === 'cto'), false);
  assert.equal(active.some((row) => row.agent === 'coo' && row.id === 'same-id'), true,
    'the same bare ID owned by another lane remains live');
  assert.equal(matchEntity('brain_alias', active), null, 'the retracted alias is removed before resolution');
});

// ── kill-switch ──────────────────────────────────────────────────────────────────────────────────
test('lookupEntity kill-switch: mode "off" short-circuits to null (no read)', async () => {
  assert.equal(await lookupEntity('n8n base url', 'off'), null);
  assert.equal(await lookupEntity('n8n base url', 'OFF'), null);
});
