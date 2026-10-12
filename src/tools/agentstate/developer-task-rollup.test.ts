import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const { handleDeveloperTaskRollup } = await import('./developer-task-rollup.js');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't_fixture', board: 'fleet', type: 'task',
    title: 'private title', description: 'private description', notes: ['private note'], tags: ['private'],
    owner_agent: 'developer', created_by: 'developer', detail_readers: ['developer'],
    status: 'open', priority: 'normal', created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z', claim_ts: null, lease_until: null,
    lease_version: 0, artifact_uri: 'private artifact', idempotency_key: null, done_ts: null,
    attempt_count: 0, ...overrides,
  } as any;
}

function deps(rows: any[], extra: Record<string, unknown> = {}) {
  return {
    isConfigured: () => true,
    listTasks: async (filter: any) => {
      (extra as any).seenFilter = filter;
      return rows;
    },
    now: () => new Date('2026-10-12T01:00:00.000Z'),
    ...extra,
  } as any;
}

test('queries only Developer page and returns aggregate source IDs without task content', async () => {
  let seen: unknown;
  const d = {
    isConfigured: () => true,
    listTasks: async (filter: unknown) => {
      seen = filter;
      return [
        task({ id: 'task_open' }),
        task({ id: 'task_blocked', status: 'blocked', updated_at: '2026-10-12T00:00:00.000Z' }),
        task({ id: 'task_unknown', status: 'paused_by_source' }),
      ];
    },
    now: () => new Date('2026-10-12T01:00:00.000Z'),
  } as any;
  const result = await handleDeveloperTaskRollup({ board: ' FLEET ', limit: 50 }, { callerAgent: ' Developer ' }, d);
  assert.deepEqual(seen, {
    owner_agent: 'developer', board: 'fleet', limit: 50, exclude_personal_legal: true,
  });
  assert.equal((result.data as any).observed_at, '2026-10-12T01:00:00.000Z');
  assert.deepEqual((result.data as any).scope, {
    board: 'fleet', owner_agent: 'developer', returned_count: 3, source_page_count: 3,
    requested_limit: 50, possibly_truncated: false, counts_are_complete: true,
    completeness_reason: 'source_exhausted', source_anomalies: [],
  });
  assert.deepEqual((result.data as any).max_observed_updated_at, '2026-10-12T00:00:00.000Z');
  assert.equal((result.data as any).status_counts.paused_by_source, 1);
  assert.deepEqual((result.data as any).source_task_ids.paused_by_source, ['task_unknown']);
  const serialized = JSON.stringify(result);
  for (const privateText of ['private title', 'private description', 'private note', 'private artifact']) {
    assert.equal(serialized.includes(privateText), false);
  }
});

test('full page reports exact observed counts and explicit uncertainty, never board totals', async () => {
  const result = await handleDeveloperTaskRollup({ limit: 2 }, { callerAgent: 'developer' }, deps([
    task({ id: 'task_a' }), task({ id: 'task_b', status: 'done' }),
  ]));
  assert.deepEqual((result.data as any).scope, {
    board: 'fleet', owner_agent: 'developer', returned_count: 2, source_page_count: 2,
    requested_limit: 2, possibly_truncated: true, counts_are_complete: false,
    completeness_reason: 'limit_reached', source_anomalies: [],
  });
  assert.equal((result.data as any).status_counts.done, 1);
  assert.deepEqual((result.data as any).source_task_ids.done, ['task_b']);
});

test('configured empty page is a complete zero distinct from an unavailable ledger', async () => {
  const empty = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, deps([]));
  assert.equal((empty.data as any).available, true);
  assert.deepEqual((empty.data as any).scope, {
    board: 'fleet', owner_agent: 'developer', returned_count: 0, source_page_count: 0,
    requested_limit: 50, possibly_truncated: false, counts_are_complete: true,
    completeness_reason: 'source_exhausted', source_anomalies: [],
  });
  assert.ok(Object.values((empty.data as any).status_counts).every((count) => count === 0));
  assert.ok(Object.values((empty.data as any).source_task_ids).every((ids: any) => ids.length === 0));
  assert.equal(Object.hasOwn(empty.data as object, 'max_observed_updated_at'), false);
  assert.equal((empty.data as any).observed_at, '2026-10-12T01:00:00.000Z');
  const missing = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, {
    isConfigured: () => false, listTasks: async () => [],
  });
  assert.deepEqual(missing.data, { available: false, error: 'ledger_not_configured' });
  assert.equal(missing.compactJsonText, true);
  assert.equal(missing.summary, 'Task ledger is not configured.');
});

test('provider failures fail closed without leaking error details or fabricating zero counts', async () => {
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, {
    isConfigured: () => true,
    listTasks: async () => { throw new Error('provider host, query text, sensitive row'); },
  });
  assert.deepEqual(result.data, { available: false, error: 'provider_read_failed' });
  assert.equal(JSON.stringify(result).includes('sensitive row'), false);
});

test('foreign callers are rejected before ledger access', async () => {
  let reads = 0;
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'cfo' }, {
    isConfigured: () => true, listTasks: async () => { reads++; return []; },
  });
  assert.deepEqual(result.data, { available: false, error: 'caller_not_authorized' });
  assert.equal(reads, 0);
});

test('invalid limits and boards return explicit input errors before ledger access', async () => {
  let reads = 0;
  const d = { isConfigured: () => true, listTasks: async () => { reads++; return []; } } as any;
  for (const input of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { board: '  ' }, { board: 'x'.repeat(101) }]) {
    const result = await handleDeveloperTaskRollup(input, { callerAgent: 'developer' }, d);
    assert.deepEqual(result.data, { available: false, error: 'invalid_input' });
  }
  assert.equal(reads, 0);
});

test('foreign owner, board, or personal rows are omitted and make page completeness uncertain', async () => {
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, deps([
    task({ id: 'own' }),
    task({ id: 'foreign_owner', owner_agent: 'cfo' }),
    task({ id: 'foreign_board', board: 'other' }),
    task({ id: 'personal_creator', created_by: 'clo-personal' }),
  ]));
  assert.equal((result.data as any).scope.returned_count, 1);
  assert.equal((result.data as any).scope.possibly_truncated, true);
  assert.equal((result.data as any).scope.counts_are_complete, false);
  assert.deepEqual((result.data as any).scope.source_anomalies, ['out_of_scope_rows_filtered']);
  assert.equal((result.data as any).status_counts.open, 1);
  assert.deepEqual((result.data as any).source_task_ids.open, ['own']);
  assert.equal(JSON.stringify(result).includes('foreign_owner'), false);
});

test('duplicate task IDs are counted once and flagged as source anomaly', async () => {
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, deps([
    task({ id: 'same_id', status: 'open', updated_at: '2026-10-11T00:00:00.000Z' }),
    task({ id: 'same_id', status: 'open', updated_at: '2026-10-12T00:00:00.000Z' }),
  ]));
  assert.equal((result.data as any).scope.returned_count, 1);
  assert.deepEqual((result.data as any).scope.source_anomalies, ['duplicate_source_ids']);
  assert.equal((result.data as any).scope.counts_are_complete, false);
  assert.equal((result.data as any).status_counts.open, 1);
  assert.deepEqual((result.data as any).source_task_ids.open, ['same_id']);
  assert.equal((result.data as any).max_observed_updated_at, '2026-10-12T00:00:00.000Z');
});

test('conflicting duplicate statuses are excluded from both counts and invalid timestamps are flagged', async () => {
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, deps([
    task({ id: 'conflict', status: 'open', updated_at: 'not-a-date' }),
    task({ id: 'conflict', status: 'done', updated_at: 'also-not-a-date' }),
    task({ id: 'stable', status: 'blocked', updated_at: '2026-10-11T00:00:00.000Z' }),
  ]));
  assert.equal((result.data as any).scope.returned_count, 1);
  assert.deepEqual((result.data as any).scope.source_anomalies, [
    'duplicate_source_ids', 'conflicting_duplicate_statuses', 'invalid_source_timestamps',
  ]);
  assert.equal((result.data as any).scope.counts_are_complete, false);
  assert.equal((result.data as any).status_counts.open, 0);
  assert.deepEqual((result.data as any).source_task_ids.open, []);
  assert.equal((result.data as any).status_counts.done, 0);
  assert.deepEqual((result.data as any).source_task_ids.done, []);
  assert.equal((result.data as any).max_observed_updated_at, '2026-10-11T00:00:00.000Z');
});

test('invalid-only timestamp observations are omitted rather than reported as null', async () => {
  const result = await handleDeveloperTaskRollup({}, { callerAgent: 'developer' }, deps([
    task({ id: 'bad_time', updated_at: 'not-a-date' }),
  ]));
  assert.deepEqual((result.data as any).scope.source_anomalies, ['invalid_source_timestamps']);
  assert.equal(Object.hasOwn(result.data as object, 'max_observed_updated_at'), false);
});

test('malformed rows and source over-return are capped and flagged without returning row data', async () => {
  const result = await handleDeveloperTaskRollup({ limit: 1 }, { callerAgent: 'developer' }, deps([
    { id: 'bad row with private content' }, task({ id: 'second_not_used' }),
  ]));
  assert.deepEqual((result.data as any).scope, {
    board: 'fleet', owner_agent: 'developer', returned_count: 0, source_page_count: 1,
    requested_limit: 1, possibly_truncated: true, counts_are_complete: false,
    completeness_reason: 'source_anomaly', source_anomalies: ['source_limit_exceeded', 'invalid_source_rows'],
  });
  assert.equal(JSON.stringify(result).includes('bad row'), false);
});


test('unauthorized callers cannot inspect or execute provider configuration', async () => {
  for (const configured of [false, true]) {
    let calls = 0;
    const result = await handleDeveloperTaskRollup({}, { callerAgent: 'cfo' }, {
      isConfigured: () => { calls++; return configured; },
      listTasks: async () => { throw new Error('must not query'); },
    });
    assert.deepEqual(result.data, { available: false, error: 'caller_not_authorized' });
    assert.equal(calls, 0);
  }
});
