import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTask, type Task, type TaskMutationDependencies } from './ledger.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_lease_synthetic', board: 'fleet', type: 'task', title: 'synthetic task',
    description: 'synthetic fixture only', owner_agent: 'developer', status: 'open',
    priority: 'normal', tags: [], artifact_uri: null, created_by: 'cto',
    created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
    claim_ts: null, lease_until: null, lease_version: 0, idempotency_key: null,
    done_ts: null, notes: [], attempt_count: 0, ...overrides,
  };
}

const hit = (doc: Task) => ({ doc: doc as unknown as Record<string, unknown>, etag: 'e1' });
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

for (const status of ['in_progress', 'blocked'] as const) {
  test(`claim preserves another agent's active ${status} lease`, async () => {
    let writes = 0;
    const result = await claimTask(
      't_lease_synthetic', 'cfo', 'fleet', undefined, undefined,
      deps({
        readDoc: async () => hit(task({
          status, owner_agent: 'developer', claim_ts: '2026-10-14T06:00:00.000Z',
          lease_until: new Date(Date.now() + 60_000).toISOString(), lease_version: 3,
        })),
        replaceDoc: async () => { writes++; return { status: 200, ok: true, body: null, etag: 'next' }; },
      }),
    );
    assert.equal(result.conflict, true);
    assert.match(result.reason ?? '', /leased to developer/);
    assert.equal(writes, 0);
  });

  test(`claim accounts for an expired ${status} lease as a reclaim`, async () => {
    let saved: Record<string, unknown> | null = null;
    const result = await claimTask(
      't_lease_synthetic', 'cfo', 'fleet', undefined, undefined,
      deps({
        readDoc: async () => hit(task({
          status, owner_agent: 'developer', claim_ts: '2026-10-14T05:00:00.000Z',
          lease_until: '2000-01-01T00:00:00.000Z', lease_version: 3, attempt_count: 1,
        })),
        replaceDoc: async (_c, _p, _i, doc) => {
          saved = doc;
          return { status: 200, ok: true, body: doc, etag: 'next' };
        },
      }),
    );
    assert.equal(result.task?.owner_agent, 'cfo');
    assert.equal(result.task?.attempt_count, 2);
    assert.equal(result.task?.lease_version, 4);
    assert.equal((saved as unknown as Task | null)?.attempt_count, 2);
  });
}

test('same holder can renew an active lease and the prior claim remains a reclaim attempt', async () => {
  const result = await claimTask(
    't_lease_synthetic', 'developer', 'fleet', undefined, undefined,
    deps({
      readDoc: async () => hit(task({
        status: 'in_progress', owner_agent: 'developer', claim_ts: '2026-10-14T06:00:00.000Z',
        lease_until: new Date(Date.now() + 60_000).toISOString(), lease_version: 3, attempt_count: 1,
      })),
    }),
  );
  assert.equal(result.task?.owner_agent, 'developer');
  assert.equal(result.task?.status, 'claimed');
  assert.equal(result.task?.attempt_count, 2);
  assert.equal(result.task?.lease_version, 4);
});

test('first-ever claim leaves the reclaim count at zero', async () => {
  const result = await claimTask(
    't_lease_synthetic', 'developer', 'fleet', undefined, undefined,
    deps({ readDoc: async () => hit(task()) }),
  );
  assert.equal(result.task?.status, 'claimed');
  assert.equal(result.task?.attempt_count, 0);
  assert.equal(result.task?.lease_version, 1);
});
