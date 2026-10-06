import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefWake, buildM365LiteWake, readWakeTasks } from './wake.js';

const task = (id: string, status: string, created_at: string, owner_agent = 'cto') => ({
  id,
  status,
  created_at,
  owner_agent,
  created_by: owner_agent,
});

test('an active task survives more than 50 newer terminal rows with storage filters before the limit', async () => {
  const calls: Record<string, unknown>[] = [];
  const terminal = Array.from({ length: 75 }, (_, i) =>
    task(`done-${i}`, 'done', `2026-10-${String(6 - Math.floor(i / 24)).padStart(2, '0')}T12:00:00Z`),
  );
  const oldOpen = task('old-open', 'open', '2026-01-01T00:00:00Z');
  const dataset = [...terminal, oldOpen];
  const result = await readWakeTasks('cto', 'cto', 10, async (filter: any) => {
    calls.push(filter);
    return dataset
      .filter((row) => row.owner_agent === filter.owner_agent && row.status === filter.status)
      .filter((row) => !filter.exclude_personal_legal || row.owner_agent !== 'clo-personal')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filter.limit) as any;
  });

  assert.deepEqual(calls.map((call) => call.status), ['open', 'claimed', 'in_progress', 'blocked']);
  for (const call of calls) {
    assert.equal(call.owner_agent, 'cto');
    assert.equal(call.limit, 50);
    assert.equal(call.exclude_personal_legal, true);
  }
  assert.deepEqual(result.active.map((row) => row.id), ['old-open']);
  assert.deepEqual(result.counts, { open: 1 });
  assert.equal(result.counts_scope, 'bounded_active_status_samples');
});

test('readWakeTasks merges active statuses by newest-first order and respects the caller cap', async () => {
  const rows: Record<string, any[]> = {
    open: [task('open', 'open', '2026-01-01T00:00:00Z')],
    claimed: [task('claimed', 'claimed', '2026-04-01T00:00:00Z')],
    in_progress: [task('working', 'in_progress', '2026-03-01T00:00:00Z')],
    blocked: [task('blocked', 'blocked', '2026-02-01T00:00:00Z')],
  };
  const result = await readWakeTasks('cto', 'cto', 2, async (filter: any) => rows[filter.status] as any);
  assert.deepEqual(result.active.map((row) => row.id), ['claimed', 'working']);
  assert.deepEqual(result.counts, { open: 1, claimed: 1, in_progress: 1, blocked: 1 });
  assert.equal(result.counts_scope, 'bounded_active_status_samples');
});

test('a surviving older task remains available to full, brief, and M365 shaping within each mode cap', async () => {
  const older = task('old-open', 'open', '2026-01-01T00:00:00Z');
  const active = await readWakeTasks('cto', 'cto', 15, async (filter: any) =>
    filter.status === 'open' ? [older] as any : [] as any,
  );
  const full: any = {
    agent: 'cto',
    pack: { configured: true, status: null, corrections: [], decisions: [], recent: [], count: 0 },
    memory_records: [],
    tasks: active,
    inbox: { configured: true, count: 0, preview: [] },
    inbound: { configured: true, count: 0, sinceMarker: '', notes: [] },
    errors: [],
    doctrine: { definition_of_done: '', pitfalls: [], standing_directives: [] },
  };

  assert.deepEqual(full.tasks.active.map((row: any) => row.id), ['old-open']);
  assert.deepEqual((buildBriefWake(full) as any).tasks.active.map((row: any) => row.id), ['old-open']);
  assert.deepEqual((buildM365LiteWake(full) as any).tasks.active.map((row: any) => row.id), ['old-open']);
  assert.equal((buildBriefWake(full) as any).tasks.counts_scope, 'bounded_active_status_samples');
  assert.equal((buildM365LiteWake(full) as any).tasks.counts_scope, 'bounded_active_status_samples');
});
