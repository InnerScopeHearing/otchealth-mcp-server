import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWake } from './wake.js';
import { requestContext } from '../../server/request-context.js';
import {
  collapseSuperseded,
  capText,
  buildDoctrinePitfalls,
  DEFINITION_OF_DONE,
  STANDING_DIRECTIVES,
  filterWakeDataForAgent,
  filterSupersededWakeData,
  wakeRecordVisibleToAgent,
  computeRetractedIds,
} from './wake.js';

test('local retraction sets normalize only the source lane prefix for full and brief current views', () => {
  const ids = computeRetractedIds([
    {agent:'cto',supersedes:'cto__old'},
    {agent:'cto',supersedes:'cro__foreign'},
  ]);
  assert.equal(ids.has('old'),true);
  assert.equal(ids.has('cro__foreign'),true);
  assert.equal(ids.has('foreign'),false);
});

test('brief wake handler backfills own canonical status behind episode chatter and keeps decision refs', async () => {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `episode-${i}`, type: 'memory', agent: 'cto', kind: 'episode', text: `tool episode ${i}` })),
    { id: 'canonical-status', type: 'memory', agent: 'cto', kind: 'status', text: 'status assertion', created_at: '2026-10-13T00:00:00Z' },
    ...Array.from({ length: 16 }, (_, i) => ({ id: `episode-later-${i}`, type: 'memory', agent: 'cto', kind: 'episode', text: `tool episode later ${i}` })),
  ];
  const calls: Array<{ agent?: string; kind?: string; limit?: number }> = [];
  const memoryRead = {
    configured: () => true,
    search: async (filter: { agent?: string; kind?: string; limit?: number }) => {
      calls.push(filter);
      return filter.kind === 'status'
        ? [{ id: 'foreign-status', type: 'memory', agent: 'clo-personal', kind: 'status', text: 'other lane' }]
        : rows;
    },
  };
  const server = { registerTool(_name: string, _config: unknown, candidate: typeof handler extends infer _ ? any : never) { handler = candidate; return { remove() {} }; } };
  const previous = setWakeTestEnv();
  try {
    registerWake(server as never, () => 'synthetic', {
      ...memoryRead,
      sharedConfigured: () => true,
      readSharedAll: async () => [
        { id: 'decision-important', ts: '2026-10-13T00:00:00Z', type: 'decision', text: 'retain exact decision reference', tags: [], agent: 'cto' },
        { id: 'correction-important', ts: '2026-10-12T00:00:00Z', type: 'correction', text: 'retain exact correction reference', tags: [], agent: 'cto' },
      ] as any,
    });
    assert.ok(handler);
    const response = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' }, () => handler!({ brief: true }));
    const result = response.structuredContent.result;
    assert.equal(result.memory_records[0].id, 'canonical-status');
    assert.equal(result.memory_records[0].kind, 'status');
    assert.equal(result.memory_records.some((record: any) => record.id === 'foreign-status'), false);
    assert.equal(result.memory_records.length, 6);
    assert.equal(calls.filter((call) => call.kind === 'status').length, 0, 'the status already in the fetched window is promoted without another query');
    assert.ok(result.pack.decisions.some((record: any) => record.id === 'decision-important'), 'decision references stay in their own section');
    assert.ok(result.pack.corrections.some((record: any) => record.id === 'correction-important'), 'correction references stay in their own section');
  } finally { restoreWakeTestEnv(previous); }
});

test('brief wake reports canonical-status query outages and keeps the ordinary memory result', async () => {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  let statusQueries = 0;
  const server = { registerTool(_name: string, _config: unknown, candidate: typeof handler extends infer _ ? any : never) { handler = candidate; return { remove() {} }; } };
  const previous = setWakeTestEnv();
  try {
    registerWake(server as never, () => 'synthetic', {
      configured: () => true,
      search: async (filter: { kind?: string }) => {
        if (filter.kind === 'status') { statusQueries += 1; throw new Error('synthetic status store outage'); }
        return [{ id: 'episode-kept', type: 'memory', agent: 'cto', kind: 'episode', text: 'available memory' }];
      },
    });
    assert.ok(handler);
    const response = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' }, () => handler!({ brief: true }));
    const result = response.structuredContent.result;
    assert.ok(result.errors.some((message: string) => message.includes('memory_status: synthetic status store outage')));
    assert.ok(result.memory_records.some((record: any) => record.id === 'episode-kept'));
    assert.equal(statusQueries, 1, 'a failed bounded lookup is not retried');
  } finally { restoreWakeTestEnv(previous); }
});

test('brief wake does not treat kind=status alone as caller ownership', async () => {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const server = { registerTool(_name: string, _config: unknown, candidate: typeof handler extends infer _ ? any : never) { handler = candidate; return { remove() {} }; } };
  const previous = setWakeTestEnv();
  try {
    registerWake(server as never, () => 'synthetic', {
      configured: () => true,
      search: async (filter: { kind?: string }) => filter.kind === 'status'
        ? [{ id: 'foreign-status', type: 'memory', agent: 'clo-personal', kind: 'status', text: 'other lane' }]
        : [{ id: 'episode-own', type: 'memory', agent: 'cto', kind: 'episode', text: 'own lane episode' }],
    });
    assert.ok(handler);
    const response = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' }, () => handler!({ brief: true }));
    const result = response.structuredContent.result;
    assert.equal(result.memory_records.some((record: any) => record.id === 'foreign-status'), false);
    assert.ok(result.memory_records.some((record: any) => record.id === 'episode-own'));
  } finally { restoreWakeTestEnv(previous); }
});

test('brief wake never restores a status retracted by a row in the fetched window', async () => {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
  const statusQueries: number[] = [];
  const server = { registerTool(_name: string, _config: unknown, candidate: typeof handler extends infer _ ? any : never) { handler = candidate; return { remove() {} }; } };
  const previous = setWakeTestEnv();
  try {
    registerWake(server as never, () => 'synthetic', {
      configured: () => true,
      search: async (filter: { kind?: string; limit?: number }) => {
        if (filter.kind === 'status') {
          statusQueries.push(filter.limit ?? 0);
          return [{ id: 'current-status', type: 'memory', agent: 'cto', kind: 'status', text: 'current assertion' }];
        }
        return [
          { id: 'episode-new', type: 'memory', agent: 'cto', kind: 'episode', supersedes: 'old-status', text: 'episode' },
          { id: 'old-status', type: 'memory', agent: 'cto', kind: 'status', text: 'stale' },
        ];
      },
    });
    assert.ok(handler);
    const response = await requestContext.run({ callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'cto' }, () => handler!({ brief: true }));
    const result = response.structuredContent.result;
    assert.equal(result.memory_records.some((record: any) => record.id === 'old-status'), false);
    assert.equal(result.memory_records[0].id, 'current-status', 'one deferred bounded lookup finds an unsuperseded status');
    assert.deepEqual(statusQueries, [4]);
  } finally { restoreWakeTestEnv(previous); }
});

function setWakeTestEnv(): Record<string, string | undefined> {
  const values = { CIO_SITE_ID: 'synthetic-site', CIO_TRACK_KEY: 'synthetic-track-key', CIO_APP_API_BEARER: 'synthetic-bearer', PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-connector-placeholder-1234567890', ADMIN_REVOKE_TOKEN: 'synthetic-admin-placeholder-1234567890', N8N_WEBHOOK_SECRET: 'synthetic-webhook-placeholder-1234567890' };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return previous;
}

function restoreWakeTestEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
import type { MemoryEntry } from '../../memory/store.js';

const entry = (id: string, extra: Record<string, unknown> = {}): MemoryEntry =>
  ({ id, ts: '2026-07-12T00:00:00Z', type: 'correction', text: `t-${id}`, tags: [], agent: 'cto', ...extra }) as unknown as MemoryEntry;

test('collapseSuperseded drops entries referenced by a newer supersedes chain', () => {
  const newest = entry('c3', { supersedes: 'c2' });
  const middle = entry('c2', { supersedes: 'c1' });
  const oldest = entry('c1');
  const out = collapseSuperseded([newest, middle, oldest]);
  assert.deepEqual(out.map((e) => e.id), ['c3']);
});

test('collapseSuperseded keeps independent corrections and preserves order', () => {
  const a = entry('a');
  const b = entry('b');
  const out = collapseSuperseded([a, b]);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b']);
});

test('collapseSuperseded ignores non-string/absent supersedes', () => {
  const weird = entry('w', { supersedes: 42 });
  const plain = entry('p');
  assert.equal(collapseSuperseded([weird, plain]).length, 2);
});

test('capText truncates long text, flags it, and keeps the id', () => {
  const rec = { id: 'x', text: 'A'.repeat(1500) };
  const out = capText(rec, 900);
  assert.equal(out.id, 'x');
  assert.ok((out.text as string).length < 1100);
  assert.ok((out.text as string).includes('truncated'));
  assert.equal((out as Record<string, unknown>)['truncated'], true);
});

test('capText leaves short text and non-string text untouched', () => {
  const short = { id: 's', text: 'hello' };
  assert.deepEqual(capText(short, 900), short);
  const noText = { id: 'n', v: 1 };
  assert.deepEqual(capText(noText as unknown as Record<string, unknown>, 900), noText);
});

test('company wake removes every protected personal-lane provenance shape while preserving company records', () => {
  for (const field of ['agent', 'by', 'from', 'sender_agent', 'owner_agent', 'created_by']) {
    assert.equal(wakeRecordVisibleToAgent({ [field]: ' CLO-PERSONAL ' }, 'clo'), false, field);
  }
  assert.equal(wakeRecordVisibleToAgent({ agent: 'clo', by: 'cto' }, 'clo'), true);
  assert.equal(wakeRecordVisibleToAgent({ by: 'clo-personal' }, 'clo-personal'), true);
});

test('company full wake final defense removes protected provenance from every record-bearing section and brief output', async () => {
  const personal = { id: 'personal', by: 'clo-personal', text: 'synthetic' };
  const company = { id: 'company', by: 'clo', text: 'synthetic' };
  const full: any = {
    agent: 'clo',
    pack: { configured: true, status: personal, corrections: [personal, company], decisions: [personal, company], recent: [personal, company], count: 2 },
    memory_records: [personal, company], tasks: { configured: true, active: [personal, company], counts: {} },
    inbox: { configured: true, count: 2, preview: [personal, company] }, inbound: { configured: true, count: 2, sinceMarker: '', notes: [personal, company] },
    errors: [], doctrine: { definition_of_done: 'synthetic', pitfalls: [], standing_directives: [] },
  };
  const filtered = filterWakeDataForAgent(full);
  assert.equal(JSON.stringify(filtered).includes('"id":"personal"'), false);
  const { buildBriefWake, buildM365LiteWake } = await import('./wake.js');
  assert.equal(JSON.stringify(buildBriefWake(filtered)).includes('"id":"personal"'), false);
  assert.equal(JSON.stringify(buildM365LiteWake(filtered)).includes('"id":"personal"'), false);
});

test('full wake applies one visible correction supersession set across every record-bearing section', async () => {
  const stale = { id: 'stale-record', type: 'fact', text: 'synthetic' };
  const correction = { id: 'current-correction', type: 'correction', supersedes: 'stale-record', text: 'synthetic' };
  const current = { id: 'current-record', type: 'fact', text: 'synthetic' };
  const full: any = {
    agent: 'clo',
    pack: { configured: true, status: stale, corrections: [correction, stale], decisions: [stale, current], recent: [stale, correction, current], count: 3 },
    memory_records: [stale, current], tasks: { configured: true, active: [stale, current], counts: {} },
    inbox: { configured: true, count: 2, preview: [stale, current] }, inbound: { configured: true, count: 2, sinceMarker: '', notes: [stale, correction, current] },
    errors: [], doctrine: { definition_of_done: 'synthetic', pitfalls: [{ id: 'stale-record', text: 'synthetic', source: 'shared_feed' }, { id: 'current-record', text: 'synthetic', source: 'shared_feed' }], standing_directives: [] },
  };
  const filtered = filterSupersededWakeData(full);
  const encoded = JSON.stringify(filtered);
  assert.equal(encoded.includes('"id":"stale-record"'), false);
  assert.equal(encoded.includes('"id":"current-correction"'), true, 'the replacement remains visible');
  assert.equal(encoded.includes('"id":"current-record"'), true, 'unrelated records remain visible');
  const { buildBriefWake, buildM365LiteWake } = await import('./wake.js');
  assert.equal(JSON.stringify(buildBriefWake(filtered)).includes('"id":"stale-record"'), false);
  assert.equal(JSON.stringify(buildM365LiteWake(filtered)).includes('"id":"stale-record"'), false);
});

// --- supersedes is now a REAL field (fix 2026-07-13) -------------------------------------------
// Before this, MemoryEntry had no `supersedes` property and nothing could write one, so
// collapseSuperseded() was dead code: a retracted belief (e.g. the wrong daily-digest root cause
// in 20260713-015) kept surfacing as a live truth. These tests pin the behaviour now that
// memory_remember / memory_write can actually set it.

test('collapseSuperseded drops a correction that a newer typed entry supersedes', () => {
  const newer = entry('20260713-017', { supersedes: '20260713-015' });
  const stale = entry('20260713-015');
  const out = collapseSuperseded([newer, stale]);
  assert.deepEqual(out.map((e) => e.id), ['20260713-017']);
});

test('collapseSuperseded follows a multi-link chain and keeps only the surviving head', () => {
  const c = entry('c', { supersedes: 'b' });
  const b = entry('b', { supersedes: 'a' });
  const a = entry('a');
  assert.deepEqual(collapseSuperseded([c, b, a]).map((e) => e.id), ['c']);
});

test('collapseSuperseded never drops an entry nothing supersedes', () => {
  const x = entry('x', { supersedes: 'does-not-exist' });
  const y = entry('y');
  assert.deepEqual(collapseSuperseded([x, y]).map((e) => e.id).sort(), ['x', 'y']);
});

// --- collapseSuperseded generalized to id+supersedes (2026-07-15, doctrine-at-wake) -------------
// Needed so the SAME helper collapses both the shared-feed MemoryEntry rows AND Cosmos
// memory-of-record rows (a different shape: kind instead of type, created_at instead of ts) when
// building the doctrine pitfall digest. This must keep working for the original MemoryEntry usage
// above AND now also for a bare {id, supersedes} shape.

test('collapseSuperseded works over a non-MemoryEntry shape carrying only id + supersedes (Cosmos rows)', () => {
  const newer = { id: 'm2', kind: 'pitfall', text: 'the fix', supersedes: 'm1' };
  const stale = { id: 'm1', kind: 'pitfall', text: 'the old wrong belief' };
  const out = collapseSuperseded([newer, stale]);
  assert.deepEqual(out.map((e) => e.id), ['m2']);
});

// ---- DOCTRINE-AT-WAKE ------------------------------------------------------------------------

test('DEFINITION_OF_DONE is the verbatim 5-part standing doctrine', () => {
  assert.equal(
    DEFINITION_OF_DONE,
    'merged + CI green; deployed + verified; an independent live call; a ledger artifact URI; a monitor whose silence pages',
  );
  // 5 parts, semicolon-delimited, per the spec.
  assert.equal(DEFINITION_OF_DONE.split(';').length, 5);
});

test('STANDING_DIRECTIVES carries the four non-negotiables', () => {
  const joined = STANDING_DIRECTIVES.join(' | ').toLowerCase();
  assert.match(joined, /ground-first/);
  assert.match(joined, /write-through/);
  assert.match(joined, /secret value/);
  assert.match(joined, /phi/);
  assert.match(joined, /non-baa/);
});

test('STANDING_DIRECTIVES contains no em/en dashes (published-string rule)', () => {
  for (const line of STANDING_DIRECTIVES) {
    assert.ok(!line.includes('\u2014'), `em dash in: ${line}`);
    assert.ok(!line.includes('\u2013'), `en dash in: ${line}`);
  }
});

test('buildDoctrinePitfalls: shared-feed pitfalls take priority, both sources merge up to the cap of 8', () => {
  const shared: MemoryEntry[] = Array.from({ length: 5 }, (_, i) =>
    entry(`s${i}`, { type: 'pitfall', text: `shared pitfall ${i}` }),
  );
  const cosmos = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: `cosmos pitfall ${i}` }));
  const out = buildDoctrinePitfalls(shared, cosmos);
  assert.equal(out.length, 8, 'capped at 8 total even though 10 candidates were offered');
  assert.equal(out.filter((p) => p.source === 'shared_feed').length, 5, 'all 5 shared-feed pitfalls fit');
  assert.equal(out.filter((p) => p.source === 'memory_of_record').length, 3, 'cosmos fills only the remaining 3 slots');
});

test('buildDoctrinePitfalls: dedupes near-identical text across the two sources', () => {
  const shared: MemoryEntry[] = [entry('s1', { type: 'pitfall', text: 'do not hardcode the webhook host' })];
  const cosmos = [{ id: 'c1', text: 'do not hardcode the webhook host' }];
  const out = buildDoctrinePitfalls(shared, cosmos);
  assert.equal(out.length, 1, 'the duplicate cosmos entry must be dropped');
  assert.equal(out[0]!.source, 'shared_feed', 'the shared-feed copy wins priority');
});

test('buildDoctrinePitfalls: skips candidates with blank/missing text', () => {
  const shared: MemoryEntry[] = [
    entry('s1', { type: 'pitfall', text: '   ' }),
    entry('s2', { type: 'pitfall' }), // no text field at all in extra, base entry() sets text='t-s2'
  ];
  const out = buildDoctrinePitfalls(shared, []);
  // s1 is blank and dropped; s2 keeps its base text 't-s2'.
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 's2');
});

test('buildDoctrinePitfalls: caps each pitfall text length and flags truncation with an ellipsis', () => {
  const longText = 'x'.repeat(500);
  const shared: MemoryEntry[] = [entry('s1', { type: 'pitfall', text: longText })];
  const out = buildDoctrinePitfalls(shared, []);
  assert.ok(out[0]!.text.length < longText.length);
  assert.ok(out[0]!.text.endsWith('.'));
});

test('buildDoctrinePitfalls: empty inputs yield an empty list (no pitfalls is a valid, safe doctrine)', () => {
  assert.deepEqual(buildDoctrinePitfalls([], []), []);
});

test('STANDING_DIRECTIVES leads with Rule #1 (the 20% stop-and-report rule, Matt 2026-09-29)', () => {
  const first = STANDING_DIRECTIVES[0] ?? '';
  assert.match(first, /RULE #1/);
  assert.match(first, /20% better/);
  assert.match(first, /Rule #1 is in effect/);
});


test('full wake unions cross-store and beyond-slice same-agent retractions while preserving a colliding other-agent ID', async () => {
  const full: any = {
    agent: 'cfo',
    pack: { configured: true, status: null, corrections: [{ id: 'collision', type: 'fact', agent: 'cfo' }], decisions: [], recent: [{ id: 'collision', type: 'fact', agent: 'cto' }], count: 2 },
    memory_records: [{ id: 'old-cross-type', kind: 'memory_record', agent: 'cfo' }, { id: 'cosmos-only', kind: 'memory_record', agent: 'cfo' }],
    tasks: { configured: true, active: [], counts: {} },
    inbox: { configured: true, count: 0, preview: [] },
    inbound: { configured: true, count: 1, sinceMarker: '', notes: [{ id: 'collision', type: 'fact', sender_agent: 'cto' }] },
    errors: [], doctrine: { definition_of_done: '', pitfalls: [], standing_directives: [] },
  };
  const completeFeed = [{ id: 'decision-beyond-cutoff', type: 'decision', agent: 'cfo', supersedes: 'old-cross-type' }];
  const externalIds = new Set(['cosmos-only', 'collision']);
  const result = filterSupersededWakeData(full, completeFeed, externalIds);
  const visibleIds = JSON.stringify(result);
  assert.equal(visibleIds.includes('old-cross-type'), false, 'cross-type local proof from beyond the output slice must apply');
  assert.equal(visibleIds.includes('cosmos-only'), false, 'canonical cross-store retraction must apply in full mode');
  const localOnly = filterSupersededWakeData(full, completeFeed, new Set());
  assert.equal(JSON.stringify(localOnly).includes('old-cross-type'), false, 'locally proven rows stay retracted if canonical lookup fails open');
  assert.equal(result.pack.corrections.some((r: any) => r.id === 'collision'), false);
  assert.equal(result.pack.recent.some((r: any) => r.id === 'collision'), true, 'same bare id on another agent must remain visible');
  const { buildBriefWake } = await import('./wake.js');
  const brief = buildBriefWake(full, completeFeed, externalIds) as any;
  assert.equal(brief.inbound.notes.some((r: any) => r.id === 'collision'), true, 'brief mode must retain another agent\'s colliding inbound id');
});
