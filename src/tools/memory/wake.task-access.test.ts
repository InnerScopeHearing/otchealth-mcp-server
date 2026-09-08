import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../../agentstate/ledger.js';
import { buildTaskListQuery } from '../../agentstate/ledger.js';
import { translate } from '../../agentstate/pg-sql.js';
import { readWakeTasks } from './wake.js';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id, board: 'fleet', type: 'task', title: 'Synthetic task', description: 'Synthetic fixture',
    owner_agent: 'cfo', created_by: 'cto', status: 'open', priority: 'normal', tags: [],
    artifact_uri: null, created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z',
    claim_ts: null, lease_until: null, lease_version: 0, idempotency_key: null,
    done_ts: null, notes: [], attempt_count: 0, ...overrides,
  } as Task;
}

test('wake passes owner and creator exclusions through the actual database translator before its cap', async () => {
  let query;
  const result = await readWakeTasks('cfo', 'cfo', 1, async (filter) => {
    assert.deepEqual(filter, { owner_agent: 'cfo', limit: 50, exclude_personal_legal: true });
    const built = buildTaskListQuery(filter);
    query = translate({ table: 'agentstate_tasks', query: built.query, parameters: built.parameters, pk: built.board, max: built.max });
    return [task('ordinary')];
  });
  assert.ok(query);
  assert.match(query.text, /owner_agent.*!=/);
  assert.match(query.text, /created_by.*!=/);
  assert.ok(query.text.indexOf('created_by') < query.text.indexOf('LIMIT'));
  assert.ok(query.values.includes('clo-personal'));
  assert.doesNotMatch(query.text, /clo-personal/);
  assert.deepEqual(result.active.map((row) => row.id), ['ordinary']);
});

test('wake excludes hidden owners and creators before counts, active filtering and preview limits', async () => {
  const result = await readWakeTasks('cfo', 'cfo', 1, async () => [
    task('hidden-creator', { created_by: ' CLO-PERSONAL ', status: 'blocked' }),
    task('hidden-owner', { owner_agent: 'clo-personal', status: 'done' }),
    task('ordinary-first'),
    task('ordinary-second', { status: 'in_progress' }),
  ]);
  assert.deepEqual(result.counts, { open: 1, in_progress: 1 });
  assert.deepEqual(result.active.map((row) => row.id), ['ordinary-first']);
  assert.doesNotMatch(JSON.stringify(result), /hidden-/);
});

test('wake retains existing personal-ring reads when authenticated as that ring', async () => {
  for (const caller of ['exec', 'clo-personal']) {
    const result = await readWakeTasks(caller, caller, 2, async (filter) => {
      assert.equal(filter.exclude_personal_legal, false);
      return [task('allowed-personal', { owner_agent: caller, created_by: 'clo-personal' })];
    });
    assert.deepEqual(result.active.map((row) => row.id), ['allowed-personal']);
  }
});

test('a caller-less internal wake cannot impersonate a personal ring by selecting its target', async () => {
  const result = await readWakeTasks('clo-personal', '', 2, async (filter) => {
    assert.equal(filter.exclude_personal_legal, true);
    return [task('hidden', { owner_agent: 'clo-personal' })];
  });
  assert.deepEqual(result, { configured: true, active: [], counts: {} });
});
