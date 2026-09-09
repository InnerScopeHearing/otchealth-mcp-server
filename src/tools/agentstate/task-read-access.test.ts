import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const { buildTaskListQuery } = await import('../../agentstate/ledger.js');
const { handleTaskList } = await import('./task-list.js');
const { handleTaskGet } = await import('./task-get.js');
const {
  canReadPersonalTasks,
  isPersonalTask,
  taskVisibleToCaller,
} = await import('./task-read-access.js');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't_fixture',
    board: 'fleet',
    type: 'task',
    title: 'Synthetic task',
    description: 'Synthetic description',
    owner_agent: 'developer',
    status: 'open',
    priority: 'normal',
    tags: [],
    artifact_uri: null,
    created_by: 'cfo',
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    claim_ts: null,
    lease_until: null,
    lease_version: 0,
    idempotency_key: null,
    done_ts: null,
    notes: [],
    attempt_count: 0,
    ...overrides,
  } as any;
}

test('existing personal-legal ring is the exact grant for personal tasks', () => {
  for (const caller of ['clo-personal', 'exec', ' CLO-PERSONAL ']) {
    assert.equal(canReadPersonalTasks(caller), true, caller);
  }
  for (const caller of ['', 'cfo', 'clo', 'cto', 'developer', 'coo', 'cro', 'external-read']) {
    assert.equal(canReadPersonalTasks(caller), false, caller || '(empty)');
  }
});

test('personal ownership or creation protects a task while ordinary company tasks remain shared', () => {
  const ordinary = task({ owner_agent: 'coo', created_by: 'cfo' });
  const personalOwner = task({ owner_agent: 'clo-personal', created_by: 'cfo' });
  const personalCreator = task({ owner_agent: 'developer', created_by: 'clo-personal' });
  assert.equal(isPersonalTask(ordinary), false);
  assert.equal(isPersonalTask(personalOwner), true);
  assert.equal(isPersonalTask(personalCreator), true);
  assert.equal(taskVisibleToCaller(ordinary, 'cro'), true);
  assert.equal(taskVisibleToCaller(personalOwner, 'cfo'), false);
  assert.equal(taskVisibleToCaller(personalCreator, 'clo'), false);
  assert.equal(taskVisibleToCaller(personalOwner, 'exec'), true);
});

test('ordinary list query excludes personal owner and creator before applying max', () => {
  const built = buildTaskListQuery({
    owner_agent: 'developer',
    status: 'open',
    board: 'fleet',
    limit: 1,
    exclude_personal_legal: true,
  });
  assert.match(built.query, /c\.owner_agent = @owner/);
  assert.match(built.query, /c\.owner_agent != @personal_agent/);
  assert.match(built.query, /c\.created_by != @personal_agent/);
  assert.match(built.query, /ORDER BY c\.created_at DESC$/);
  assert.equal(built.max, 1);
  assert.deepEqual(
    built.parameters.find((p: { name: string }) => p.name === '@personal_agent'),
    { name: '@personal_agent', value: 'clo-personal' },
  );
});

test('personal-ring list query preserves the ordinary shared-company query', () => {
  const built = buildTaskListQuery({ limit: 2, exclude_personal_legal: false });
  assert.doesNotMatch(built.query, /personal_agent/);
  assert.deepEqual(built.parameters, [{ name: '@board', value: 'fleet' }]);
  assert.equal(built.max, 2);
});

test('task_list sends the exclusion to storage and post-filters a malformed adapter result', async () => {
  const ordinary = task({ id: 't_ordinary', owner_agent: 'coo', created_by: 'cfo' });
  const personal = task({ id: 't_personal', owner_agent: 'clo-personal' });
  let seen: unknown;
  const result = await handleTaskList(
    { status: 'open', limit: 1 },
    { callerAgent: 'cfo' },
    {
      isConfigured: () => true,
      listTasks: async (filter) => {
        seen = filter;
        return [personal, ordinary];
      },
    },
  );
  assert.deepEqual(seen, { status: 'open', limit: 1, exclude_personal_legal: true });
  assert.deepEqual((result.data as any).tasks.map((t: { id: string }) => t.id), ['t_ordinary']);
  assert.equal((result.data as any).count, 1);
});

test('task_list lets personal-ring callers retain personal and ordinary tasks', async () => {
  const rows = [
    task({ id: 't_personal', owner_agent: 'clo-personal' }),
    task({ id: 't_ordinary', owner_agent: 'developer' }),
  ];
  let seen: unknown;
  const result = await handleTaskList(
    {},
    { callerAgent: 'exec' },
    {
      isConfigured: () => true,
      listTasks: async (filter) => {
        seen = filter;
        return rows;
      },
    },
  );
  assert.deepEqual(seen, { exclude_personal_legal: false });
  assert.equal((result.data as any).count, 2);
});

test('task_get denies a personal task before event fetch with the exact missing envelope', async () => {
  const hidden = task({ id: 't_hidden', owner_agent: 'developer', created_by: 'clo-personal' });
  let eventCalls = 0;
  const deps = {
    isConfigured: () => true,
    getTask: async () => hidden,
    listEvents: async () => {
      eventCalls++;
      return [{ detail: 'must not be read' }];
    },
  };
  const denied = await handleTaskGet(
    { task_id: 't_hidden', include_events: true },
    { callerAgent: 'cfo' },
    deps,
  );
  const missing = await handleTaskGet(
    { task_id: 't_hidden', include_events: true },
    { callerAgent: 'cfo' },
    { ...deps, getTask: async () => null },
  );
  assert.deepEqual(denied, missing);
  assert.deepEqual(denied.data, { found: false, task: null });
  assert.equal(eventCalls, 0);
});

test('task_get preserves cross-company reads and personal-ring access', async () => {
  let eventCalls = 0;
  const events = [{ kind: 'synthetic' }];
  const read = async (row: any, callerAgent: string) => handleTaskGet(
    { task_id: row.id },
    { callerAgent },
    {
      isConfigured: () => true,
      getTask: async () => row,
      listEvents: async () => {
        eventCalls++;
        return events;
      },
    },
  );

  const ordinary = await read(task({ id: 't_cross', owner_agent: 'coo', created_by: 'cfo' }), 'cro');
  const personal = await read(task({ id: 't_private', owner_agent: 'clo-personal' }), 'clo-personal');
  assert.equal((ordinary.data as any).found, true);
  assert.equal((personal.data as any).found, true);
  assert.equal(eventCalls, 2);
});
