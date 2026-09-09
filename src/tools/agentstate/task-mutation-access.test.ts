import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '../registry.js';
import { TaskAccessDeniedError, type Task } from '../../agentstate/ledger.js';
import { handleTaskCreate } from './task-create.js';
import { handleTaskClaim } from './task-claim.js';
import { handleTaskHeartbeat } from './task-heartbeat.js';
import { handleTaskUpdate } from './task-update.js';
import { handleTaskComplete } from './task-complete.js';
import { taskVisibleToCaller } from './task-read-access.js';

const ctx = (callerAgent: string): ToolContext => ({
  correlationId: 'synthetic-correlation', callerHash: 'synthetic-hash',
  callerAgent, dryRun: false, acknowledgeWarning: false,
});
function hidden(): Task {
  return {
    id: 't_synthetic_hidden', board: 'fleet', type: 'task', title: 'synthetic protected task',
    description: 'synthetic fixture only', owner_agent: 'clo-personal', status: 'claimed',
    priority: 'normal', tags: [], artifact_uri: null, created_by: 'cto',
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    claim_ts: '2026-09-08T00:00:00.000Z', lease_until: '2026-09-08T00:45:00.000Z',
    lease_version: 1, idempotency_key: 'synthetic', done_ts: null, notes: [], attempt_count: 0,
  };
}

test('task_create handler hides caller-chosen idempotency results', async () => {
  let denied = false;
  const result = await handleTaskCreate(
    { title: 'synthetic', owner_agent: 'developer', created_by: 'cfo', idempotency_key: 'chosen' },
    ctx('cfo'),
    {
      isConfigured: () => true,
      taskVisibleToCaller,
      createTask: async (_input, guard) => {
        denied = guard?.(hidden()) === false;
        throw new TaskAccessDeniedError();
      },
    },
  );
  const data = result.data as Record<string, unknown>;
  assert.equal(denied, true);
  assert.deepEqual({ created: data.created, task: data.task, reason: data.reason }, {
    created: false, task: null, reason: 'task not found or unavailable',
  });
});

test('all four existing-task handlers bind policy to the authenticated caller', async () => {
  const protectedTask = hidden();
  const refuse = (guard: ((task: Readonly<Task>) => boolean) | undefined) => {
    assert.equal(guard?.(protectedTask), false);
    return { reason: 'not found' };
  };
  const results = [
    await handleTaskClaim({ task_id: protectedTask.id, agent: 'cto' }, ctx('cfo'), {
      isConfigured: () => true, taskVisibleToCaller,
      claimTask: async (_i, _a, _b, _c, guard) => refuse(guard),
    }),
    await handleTaskHeartbeat({ task_id: protectedTask.id, agent: 'cto' }, ctx('cfo'), {
      isConfigured: () => true, taskVisibleToCaller,
      heartbeatTask: async (_i, _a, _b, _v, _c, guard) => refuse(guard),
    }),
    await handleTaskUpdate({ task_id: protectedTask.id, actor: 'cto', note: 'synthetic' }, ctx('cfo'), {
      isConfigured: () => true, taskVisibleToCaller,
      updateTask: async (_i, _p, _a, _b, _v, _c, guard) => refuse(guard),
    }),
    await handleTaskComplete(
      { task_id: protectedTask.id, artifact_uri: 'gh:commit:synthetic/repo@0000000', agent: 'cto' },
      ctx('cfo'),
      {
        isConfigured: () => true, taskVisibleToCaller,
        completeTask: async (_i, _u, _a, _n, _b, _v, _c, guard) => refuse(guard),
      },
    ),
  ];
  for (const result of results) {
    const data = result.data as Record<string, unknown>;
    assert.equal('task' in data, false);
    assert.equal(data.reason, 'not found');
  }
});

test('protected create and reassignment stop before core dispatch', async () => {
  let calls = 0;
  const create = await handleTaskCreate(
    { title: 'synthetic', owner_agent: 'clo-personal', created_by: 'cfo' },
    ctx('cfo'),
    {
      isConfigured: () => true, taskVisibleToCaller,
      createTask: async () => { calls++; return { task: hidden(), deduped: false }; },
    },
  );
  const update = await handleTaskUpdate(
    { task_id: 't_synthetic', actor: 'cfo', owner_agent: 'clo-personal' },
    ctx('cfo'),
    {
      isConfigured: () => true, taskVisibleToCaller,
      updateTask: async () => { calls++; return { task: hidden() }; },
    },
  );
  assert.equal(calls, 0);
  assert.equal((create.data as Record<string, unknown>).created, false);
  assert.equal((update.data as Record<string, unknown>).updated, false);
});

test('existing personal legal ring retains access', async () => {
  const protectedTask = hidden();
  const result = await handleTaskHeartbeat(
    { task_id: protectedTask.id, agent: 'exec' },
    ctx('exec'),
    {
      isConfigured: () => true, taskVisibleToCaller,
      heartbeatTask: async (_i, _a, _b, _v, _c, guard) => {
        assert.equal(guard?.(protectedTask), true);
        return { task: { ...protectedTask, owner_agent: 'exec' } };
      },
    },
  );
  assert.equal((result.data as Record<string, unknown>).extended, true);
});
