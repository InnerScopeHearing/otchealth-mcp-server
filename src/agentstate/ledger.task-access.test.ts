import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskAccessDeniedError, claimTask, completeTask, createTask, heartbeatTask, updateTask,
  type Task, type TaskMutationDependencies,
} from './ledger.js';
import { taskVisibleToCaller } from '../tools/agentstate/task-read-access.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_synthetic', board: 'fleet', type: 'task', title: 'synthetic task',
    description: 'synthetic fixture only', owner_agent: 'developer', status: 'open',
    priority: 'normal', tags: [], artifact_uri: null, created_by: 'cto',
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    claim_ts: null, lease_until: null, lease_version: 0, idempotency_key: null,
    done_ts: null, notes: [], attempt_count: 0, ...overrides,
  };
}
const hit = (doc: Task, etag = 'e1') => ({ doc: doc as unknown as Record<string, unknown>, etag });
function deps(overrides: Partial<TaskMutationDependencies> = {}): TaskMutationDependencies {
  return {
    readDoc: async () => null,
    createDoc: async (_c, _p, doc) => ({ status: 201, ok: true, body: doc, etag: 'new' }),
    replaceDoc: async (_c, _p, _i, doc) => ({ status: 200, ok: true, body: doc, etag: 'next' }),
    resolveArtifact: async () => ({ resolved: true, scheme: 'gh', detail: 'synthetic artifact' }),
    appendEvent: async () => undefined,
    ...overrides,
  } as TaskMutationDependencies;
}
const guard = (value: Readonly<Task>) => taskVisibleToCaller(value, 'cfo');

test('create hides both initial and create-race idempotency hits', async () => {
  const hidden = task({ owner_agent: 'clo-personal', idempotency_key: 'chosen' });
  let creates = 0;
  await assert.rejects(
    createTask(
      { title: 'synthetic', owner_agent: 'developer', created_by: 'cfo', idempotency_key: 'chosen' },
      guard,
      deps({ readDoc: async () => hit(hidden), createDoc: async () => { creates++; throw Error('no'); } }),
    ),
    TaskAccessDeniedError,
  );
  assert.equal(creates, 0);

  const reads = [null, hit(hidden)];
  let events = 0;
  await assert.rejects(
    createTask(
      { title: 'synthetic', owner_agent: 'developer', created_by: 'cfo', idempotency_key: 'chosen' },
      guard,
      deps({
        readDoc: async () => reads.shift() ?? null,
        createDoc: async () => { throw Error('synthetic conflict'); },
        appendEvent: async () => { events++; },
      }),
    ),
    TaskAccessDeniedError,
  );
  assert.equal(events, 0);
});

test('create rejects protected targets but preserves ordinary cross-seat creation', async () => {
  let creates = 0;
  await assert.rejects(
    createTask(
      { title: 'synthetic', owner_agent: 'clo-personal', created_by: 'cfo' },
      guard,
      deps({ createDoc: async () => { creates++; throw Error('no'); } }),
    ),
    TaskAccessDeniedError,
  );
  assert.equal(creates, 0);
  const ordinary = await createTask(
    { title: 'synthetic', owner_agent: 'developer', created_by: 'cfo' },
    guard,
    deps(),
  );
  assert.equal(ordinary.task.owner_agent, 'developer');
  assert.equal(ordinary.task.created_by, 'cfo');
});

test('claim checks the fresh task after a CAS retry', async () => {
  const reads = [hit(task(), 'e1'), hit(task({ owner_agent: 'clo-personal' }), 'e2')];
  let replacements = 0;
  const result = await claimTask(
    't_synthetic', 'cfo', 'fleet', undefined, guard,
    deps({
      readDoc: async () => reads.shift() ?? null,
      replaceDoc: async () => {
        replacements++;
        return { status: 412, ok: false, body: null, etag: null };
      },
    }),
  );
  assert.deepEqual(result, { reason: 'not found' });
  assert.equal(replacements, 1);
});

test('heartbeat and update refuse hidden rows without side effects', async () => {
  let writes = 0;
  let events = 0;
  const hiddenDeps = deps({
    readDoc: async () => hit(task({ owner_agent: 'clo-personal', status: 'claimed' })),
    replaceDoc: async () => { writes++; return { status: 200, ok: true, body: null, etag: 'next' }; },
    appendEvent: async () => { events++; },
  });
  assert.deepEqual(
    await heartbeatTask('t_synthetic', 'cfo', 'fleet', undefined, undefined, guard, hiddenDeps),
    { reason: 'not found' },
  );
  assert.deepEqual(
    await updateTask('t_synthetic', { note: 'synthetic' }, 'cfo', 'fleet', undefined, undefined, guard, hiddenDeps),
    { reason: 'not found' },
  );
  assert.equal(writes, 0);
  assert.equal(events, 0);
});

test('update rejects a reassignment that crosses the task policy', async () => {
  let writes = 0;
  const result = await updateTask(
    't_synthetic', { owner_agent: 'clo-personal' }, 'cfo', 'fleet', undefined, undefined, guard,
    deps({
      readDoc: async () => hit(task()),
      replaceDoc: async () => { writes++; return { status: 200, ok: true, body: null, etag: 'next' }; },
    }),
  );
  assert.deepEqual(result, { reason: 'owner reassignment is not permitted by task visibility policy' });
  assert.equal(writes, 0);
});

test('complete checks access before artifact resolution', async () => {
  let resolutions = 0;
  let writes = 0;
  let events = 0;
  const result = await completeTask(
    't_synthetic', 'gh:commit:synthetic/repo@0000000', 'cfo', undefined,
    'fleet', undefined, undefined, guard,
    deps({
      readDoc: async () => hit(task({ owner_agent: 'clo-personal' })),
      resolveArtifact: async () => { resolutions++; return { resolved: true, scheme: 'gh', detail: 'ok' }; },
      replaceDoc: async () => { writes++; return { status: 200, ok: true, body: null, etag: 'next' }; },
      appendEvent: async () => { events++; },
    }),
  );
  assert.deepEqual(result, { reason: 'not found' });
  assert.deepEqual({ resolutions, writes, events }, { resolutions: 0, writes: 0, events: 0 });
});

test('complete rechecks access after asynchronous resolution', async () => {
  const reads = [
    hit(task({ status: 'claimed', owner_agent: 'cfo', lease_version: 4 }), 'e1'),
    hit(task({ status: 'claimed', owner_agent: 'clo-personal', lease_version: 5 }), 'e2'),
  ];
  let resolutions = 0;
  let writes = 0;
  let events = 0;
  const result = await completeTask(
    't_synthetic', 'gh:commit:synthetic/repo@0000000', 'cfo', undefined,
    'fleet', 4, undefined, guard,
    deps({
      readDoc: async () => reads.shift() ?? null,
      resolveArtifact: async () => { resolutions++; return { resolved: true, scheme: 'gh', detail: 'ok' }; },
      replaceDoc: async () => { writes++; return { status: 200, ok: true, body: null, etag: 'next' }; },
      appendEvent: async () => { events++; },
    }),
  );
  assert.deepEqual(result, { reason: 'not found' });
  assert.deepEqual({ resolutions, writes, events }, { resolutions: 1, writes: 0, events: 0 });
});
