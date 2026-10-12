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
    id: 't_metadata_synthetic',
    board: 'fleet',
    type: 'task',
    title: 'Synthetic build readiness task',
    description: 'SYNTHETIC_DESCRIPTION_SENTINEL',
    owner_agent: 'developer',
    status: 'claimed',
    priority: 'high',
    tags: ['synthetic-tag'],
    artifact_uri: 'gh:commit:synthetic/repo@abcdef0',
    created_by: 'cfo',
    detail_readers: ['cfo', 'developer'],
    created_at: '2026-10-11T12:00:00.000Z',
    updated_at: '2026-10-12T05:00:00.000Z',
    claim_ts: '2026-10-12T05:00:00.000Z',
    lease_until: '2026-10-12T05:45:00.000Z',
    lease_version: 7,
    idempotency_key: 'SYNTHETIC_IDEMPOTENCY_SENTINEL',
    done_ts: null,
    notes: ['SYNTHETIC_NOTE_SENTINEL_1', 'SYNTHETIC_NOTE_SENTINEL_2'],
    attempt_count: 1,
    ...overrides,
  } as any;
}

function deps(row: any, options: { configured?: boolean; events?: any[] } = {}) {
  const counts = { task: 0, events: 0 };
  return {
    counts,
    isConfigured: () => options.configured ?? true,
    getTask: async () => {
      counts.task++;
      return row;
    },
    listEvents: async () => {
      counts.events++;
      return options.events ?? [{ kind: 'synthetic-event' }];
    },
  };
}

const ctx = (callerAgent: string) => ({ callerAgent } as any);

test('task_get defaults and explicit full view preserve the full task and event behavior', async () => {
  for (const view of [undefined, 'full'] as const) {
    const row = task();
    const fixture = deps(row);
    const result = await handleTaskGet(
      { task_id: row.id, ...(view ? { view } : {}) },
      ctx('developer'),
      fixture,
    );
    assert.equal((result.data as any).task, row);
    assert.deepEqual((result.data as any).events, [{ kind: 'synthetic-event' }]);
    assert.equal('view' in (result.data as any), false);
    assert.deepEqual(fixture.counts, { task: 1, events: 1 });
  }
});

test('metadata view returns an allowlist, counts notes without exposing them, and never fetches events', async () => {
  const row = task({ notes: Array.from({ length: 300 }, (_, i) => `SYNTHETIC_NOTE_SENTINEL_${i}`) });
  const fixture = deps(row);
  const result = await handleTaskGet(
    { task_id: row.id, view: 'metadata', include_events: true },
    ctx(' Developer '),
    fixture,
  );
  const data = result.data as any;
  assert.equal(data.found, true);
  assert.deepEqual(Object.keys(data.task).sort(), [
    'artifact_uri', 'attempt_count', 'board', 'claim_ts', 'created_at', 'done_ts', 'id', 'lease_until',
    'lease_version', 'notes_count', 'owner_agent', 'priority', 'status', 'title', 'type', 'updated_at',
  ].sort());
  assert.equal(data.task.title, 'Synthetic build readiness task');
  assert.equal(data.task.lease_version, 7);
  assert.equal(data.task.created_at, '2026-10-11T12:00:00.000Z');
  assert.equal(data.task.artifact_uri, 'gh:commit:synthetic/repo@abcdef0');
  assert.equal(data.task.notes_count, 300);
  assert.deepEqual(data.events, []);
  assert.equal(data.view, 'metadata');
  assert.equal(data.details_omitted, true);
  assert.equal(data.full_fetch_required_before_action, true);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_NOTE_SENTINEL'), false);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_DESCRIPTION_SENTINEL'), false);
  assert.equal(JSON.stringify(data).includes('SYNTHETIC_IDEMPOTENCY_SENTINEL'), false);
  assert.equal('pending_gates' in data, false);
  assert.equal('approvals' in data, false);
  assert.deepEqual(fixture.counts, { task: 1, events: 0 });
});

test('metadata for a cross-seat Developer preserves coordination projection and omits detail fields', async () => {
  const row = task({ owner_agent: 'coo', created_by: 'cfo', detail_readers: ['cfo'] });
  const fixture = deps(row);
  const result = await handleTaskGet({ task_id: row.id, view: 'metadata' }, ctx('developer'), fixture);
  const data = result.data as any;
  assert.equal(data.found, true);
  assert.equal(data.task.owner_agent, 'coo');
  assert.equal(data.task.status, 'claimed');
  assert.equal(data.task.lease_version, 7);
  assert.equal('title' in data.task, false);
  assert.equal('artifact_uri' in data.task, false);
  assert.equal('notes_count' in data.task, false);
  assert.deepEqual(data.events, []);
  assert.deepEqual(fixture.counts, { task: 1, events: 0 });
});

test('metadata from another lane is a generic error before configuration or task lookup', async () => {
  const fixture = deps(task(), { configured: false });
  await assert.rejects(
    handleTaskGet({ task_id: 't_missing_or_private', view: 'metadata' }, ctx('cfo'), fixture),
    { message: 'Unsupported task_get view.' },
  );
  assert.deepEqual(fixture.counts, { task: 0, events: 0 });
});

test('metadata personal denial has the same not-found envelope as a missing task', async () => {
  const personal = task({ owner_agent: 'developer', created_by: 'clo-personal' });
  const deniedFixture = deps(personal);
  const missingFixture = deps(null);
  const denied = await handleTaskGet({ task_id: personal.id, view: 'metadata' }, ctx('developer'), deniedFixture);
  const missing = await handleTaskGet({ task_id: personal.id, view: 'metadata' }, ctx('developer'), missingFixture);
  assert.deepEqual(denied, missing);
  assert.deepEqual(denied.data, { found: false, task: null });
  assert.deepEqual(deniedFixture.counts, { task: 1, events: 0 });
  assert.deepEqual(missingFixture.counts, { task: 1, events: 0 });
});

test('metadata leaves unconfigured storage visible and propagates task and full-view event failures', async () => {
  const unavailable = deps(task(), { configured: false });
  const unavailableResult = await handleTaskGet(
    { task_id: 't_metadata_synthetic', view: 'metadata' },
    ctx('developer'),
    unavailable,
  );
  assert.deepEqual(unavailableResult.data, { found: false, note: 'agent-state Cosmos not configured.' });
  assert.deepEqual(unavailable.counts, { task: 0, events: 0 });

  const taskError = new Error('synthetic task provider failure');
  await assert.rejects(handleTaskGet(
    { task_id: 't_metadata_synthetic', view: 'metadata' },
    ctx('developer'),
    { ...deps(task()), getTask: async () => { throw taskError; } },
  ), taskError);

  const eventError = new Error('synthetic event provider failure');
  await assert.rejects(handleTaskGet(
    { task_id: 't_metadata_synthetic' },
    ctx('developer'),
    { ...deps(task()), listEvents: async () => { throw eventError; } },
  ), eventError);
});

test('registered task_get schema accepts full/metadata and rejects unknown views', () => {
  let captured: any;
  const server = {
    registerTool: (_name: string, config: any) => {
      captured = config;
      return {};
    },
  } as any;
  registerTaskGet(server, () => 'synthetic-caller-hash');
  assert.ok(captured?.inputSchema?.view);
  assert.equal(captured.inputSchema.view.safeParse('full').success, true);
  assert.equal(captured.inputSchema.view.safeParse('metadata').success, true);
  assert.equal(captured.inputSchema.view.safeParse('unbounded').success, false);
});
