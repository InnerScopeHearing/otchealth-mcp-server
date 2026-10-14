import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const { handleTaskGet, registerTaskGet } = await import('./task-get.js');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't_metadata_pilot_synthetic', board: 'fleet', type: 'task',
    title: 'Synthetic response-view task', description: 'SYNTHETIC_DESCRIPTION_SENTINEL',
    owner_agent: 'developer', status: 'claimed', priority: 'high', tags: ['synthetic'],
    artifact_uri: 'gh:commit:synthetic/repo@abcdef0', created_by: 'cfo', detail_readers: ['cfo', 'developer'],
    created_at: '2026-10-11T12:00:00.000Z', updated_at: '2026-10-12T05:00:00.000Z',
    claim_ts: '2026-10-12T05:00:00.000Z', lease_until: '2026-10-12T05:45:00.000Z',
    lease_version: 7, idempotency_key: 'SYNTHETIC_IDEMPOTENCY_SENTINEL', done_ts: null,
    notes: ['SYNTHETIC_NOTE_SENTINEL'], attempt_count: 1, ...overrides,
  } as any;
}

function provider(row: any, events: any[] = [{ kind: 'synthetic', detail: 'synthetic event' }]) {
  const calls = { task: 0, events: 0 };
  return {
    calls,
    isConfigured: () => true,
    getTask: async () => { calls.task++; return row; },
    listEvents: async () => { calls.events++; return events; },
  };
}

test('task_get defaults and explicit full view preserve existing response and history behavior', async () => {
  for (const view of [undefined, 'full'] as const) {
    const row = task();
    const deps = provider(row);
    const result = await handleTaskGet({ task_id: row.id, ...(view ? { view } : {}) }, { callerAgent: 'developer' }, deps);
    assert.equal((result.data as any).task, row);
    assert.deepEqual((result.data as any).events, [{ kind: 'synthetic', detail: 'synthetic event' }]);
    assert.equal('view' in (result.data as any), false);
    assert.deepEqual(deps.calls, { task: 1, events: 1 });
  }
});

test('metadata returns a bounded allowlist and never queries event history or emits note bodies', async () => {
  const row = task({ notes: Array.from({ length: 300 }, (_, i) => `SYNTHETIC_NOTE_SENTINEL_${i}`) });
  const deps = provider(row);
  const result = await handleTaskGet({ task_id: row.id, view: 'metadata', include_events: true }, { callerAgent: ' Developer ' }, deps);
  const data = result.data as any;
  assert.equal(data.found, true);
  assert.deepEqual(Object.keys(data.task).sort(), [
    'artifact_uri', 'attempt_count', 'board', 'claim_ts', 'created_at', 'done_ts', 'id', 'lease_until',
    'lease_version', 'notes_count', 'owner_agent', 'priority', 'status', 'title', 'type', 'updated_at',
  ].sort());
  assert.equal(data.task.notes_count, 300);
  assert.deepEqual(data.events, []);
  assert.equal(data.view, 'metadata');
  assert.equal(data.full_fetch_required_before_action, true);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_NOTE_SENTINEL'), false);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_DESCRIPTION_SENTINEL'), false);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_IDEMPOTENCY_SENTINEL'), false);
  assert.equal('approvals' in data, false);
  assert.equal('pending_gates' in data, false);
  assert.deepEqual(deps.calls, { task: 1, events: 0 });
});

test('metadata preserves the legacy attempt_count default for old task documents', async () => {
  const legacy = task();
  delete legacy.attempt_count;
  const deps = provider(legacy);
  const result = await handleTaskGet({ task_id: legacy.id, context_need: 'coordination' }, { callerAgent: 'developer' }, deps);
  assert.equal((result.data as any).task.attempt_count, 0);
  assert.equal(legacy.attempt_count, undefined);
  assert.deepEqual(deps.calls, { task: 1, events: 0 });
});

test('metadata cannot widen immutable detail grants or cross-seat status-only projection', async () => {
  const row = task({ owner_agent: 'coo', created_by: 'cfo', detail_readers: ['cfo'] });
  const deps = provider(row);
  const result = await handleTaskGet({ task_id: row.id, view: 'metadata' }, { callerAgent: 'developer' }, deps);
  const data = result.data as any;
  assert.equal(data.task.status, 'claimed');
  assert.equal(data.task.owner_agent, 'coo');
  for (const field of ['title', 'artifact_uri', 'notes_count', 'description', 'tags', 'created_by']) {
    assert.equal(field in data.task, false, `unexpected field ${field}`);
  }
  assert.deepEqual(data.events, []);
  assert.deepEqual(deps.calls, { task: 1, events: 0 });
});

test('unsupported caller is rejected before configuration or lookup', async () => {
  const deps = { ...provider(task()), isConfigured: () => false };
  await assert.rejects(handleTaskGet({ task_id: 'synthetic', view: 'metadata' }, { callerAgent: 'cfo' }, deps), /Unsupported task_get view/);
  assert.deepEqual(deps.calls, { task: 0, events: 0 });
  await assert.rejects(
    handleTaskGet({ task_id: 'synthetic', context_need: 'approval' }, { callerAgent: 'cfo' }, deps),
    /task_get context_need is Developer-only; omit context_need for the supported full read\./,
  );
  assert.deepEqual(deps.calls, { task: 0, events: 0 });
});

test('controller context_need selects metadata only for coordination and full detail for approval, correction, notes, and history', async () => {
  const row = task({ notes: ['Synthetic approval granted for demonstration.'] });
  for (const context_need of ['notes', 'history', 'approval', 'correction'] as const) {
    const deps = provider(row, [{ kind: 'updated', detail: 'Synthetic correction supersedes prior approval.' }]);
    const result = await handleTaskGet({ task_id: row.id, context_need, include_events: false }, { callerAgent: 'developer' }, deps);
    assert.equal((result.data as any).task, row, `${context_need} must select the full task`);
    const historyRequired = context_need !== 'notes';
    assert.deepEqual((result.data as any).events, historyRequired ? [{ kind: 'updated', detail: 'Synthetic correction supersedes prior approval.' }] : [], `${context_need} history routing`);
    assert.deepEqual(deps.calls, { task: 1, events: historyRequired ? 1 : 0 });
  }
  const coordinationDeps = provider(row);
  const coordination = await handleTaskGet({ task_id: row.id, context_need: 'coordination' }, { callerAgent: 'developer' }, coordinationDeps);
  assert.equal((coordination.data as any).view, 'metadata');
  assert.equal((coordination.data as any).task.status, 'claimed');
  assert.equal('notes' in (coordination.data as any).task, false);
  assert.deepEqual(coordinationDeps.calls, { task: 1, events: 0 });
});

test('matching explicit view and context_need are accepted; mismatches fail before any provider access', async () => {
  const row = task();
  const matchingMetadataDeps = provider(row);
  const matchingMetadata = await handleTaskGet(
    { task_id: row.id, view: 'metadata', context_need: 'coordination' },
    { callerAgent: 'developer' },
    matchingMetadataDeps,
  );
  assert.equal((matchingMetadata.data as any).view, 'metadata');
  assert.deepEqual(matchingMetadataDeps.calls, { task: 1, events: 0 });

  const matchingFullDeps = provider(row);
  const matchingFull = await handleTaskGet(
    { task_id: row.id, view: 'full', context_need: 'approval' },
    { callerAgent: 'developer' },
    matchingFullDeps,
  );
  assert.equal((matchingFull.data as any).found, true);
  assert.equal('view' in (matchingFull.data as any), false);
  assert.deepEqual(matchingFullDeps.calls, { task: 1, events: 1 });

  for (const input of [
    { task_id: row.id, view: 'metadata' as const, context_need: 'approval' as const },
    { task_id: row.id, view: 'full' as const, context_need: 'coordination' as const },
  ]) {
    const calls = { configuration: 0, task: 0, events: 0 };
    const deps = {
      isConfigured: () => { calls.configuration++; return false; },
      getTask: async () => { calls.task++; return row; },
      listEvents: async () => { calls.events++; return []; },
    };
    await assert.rejects(
      handleTaskGet(input, { callerAgent: 'developer' }, deps),
      /Conflicting task_get view and context_need/,
    );
    assert.deepEqual(calls, { configuration: 0, task: 0, events: 0 });
  }
});

test('personal task denial remains indistinguishable from missing task in metadata view', async () => {
  const hiddenDeps = provider(task({ owner_agent: 'developer', created_by: 'clo-personal' }));
  const missingDeps = provider(null);
  const hidden = await handleTaskGet({ task_id: 'synthetic', view: 'metadata' }, { callerAgent: 'developer' }, hiddenDeps);
  const missing = await handleTaskGet({ task_id: 'synthetic', view: 'metadata' }, { callerAgent: 'developer' }, missingDeps);
  assert.deepEqual(hidden, missing);
  assert.deepEqual(hidden.data, { found: false, task: null });
  assert.deepEqual(hiddenDeps.calls, { task: 1, events: 0 });
  assert.deepEqual(missingDeps.calls, { task: 1, events: 0 });
});

test('metadata omits event query while provider failure behavior stays fixed for task and full-view event reads', async () => {
  const row = task();
  const taskFailure = new Error('synthetic task provider failure');
  await assert.rejects(handleTaskGet({ task_id: row.id, view: 'metadata' }, { callerAgent: 'developer' }, {
    ...provider(row), getTask: async () => { throw taskFailure; },
  }), taskFailure);
  const eventFailure = new Error('synthetic event provider failure');
  await assert.rejects(handleTaskGet({ task_id: row.id, view: 'full' }, { callerAgent: 'developer' }, {
    ...provider(row), listEvents: async () => { throw eventFailure; },
  }), eventFailure);
});

test('registered task_get schema exposes optional metadata view and rejects unsupported values', () => {
  let captured: any;
  const server = { registerTool: (_name: string, config: any) => { captured = config; return {}; } } as any;
  registerTaskGet(server, () => 'synthetic-caller-hash');
  assert.ok(captured?.inputSchema?.view);
  assert.equal(captured.inputSchema.view.safeParse('full').success, true);
  assert.equal(captured.inputSchema.view.safeParse('metadata').success, true);
  assert.equal(captured.inputSchema.view.safeParse('unknown').success, false);
  for (const value of ['coordination', 'notes', 'history', 'approval', 'correction']) {
    assert.equal(captured.inputSchema.context_need.safeParse(value).success, true);
  }
  assert.equal(captured.inputSchema.context_need.safeParse('arbitrary').success, false);
});
