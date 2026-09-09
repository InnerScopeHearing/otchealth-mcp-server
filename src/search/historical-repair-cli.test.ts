import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseHistoricalRepairArgs, runHistoricalRepairCli } from './historical-repair-cli.js';
import { runHistoricalRepair } from './opensearch-backfill.js';

test('repair CLI defaults to dry run and rejects unbounded or malformed options', () => {
  assert.equal(parseHistoricalRepairArgs(['--agent', 'cfo', '--max', '25']).dryRun, true);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--max', '201']), /max_invalid/);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--unknown', 'x']), /args_invalid/);
});

test('repair CLI emits metadata only and fails closed until complete', async () => {
  const result = await runHistoricalRepairCli(['--agent', 'cfo'], async options => ({ mode: 'historical-reconciliation', index: options.index || 'memory-exec', since: '', fetched: 1, indexed: 0, failed: 0, truncated: true, dryRun: options.dryRun, errors: ['sensitive backend body omitted'], checked: 1, already_indexed: 0, checkpoint: { version: 'memory-index-repair-v1', agent: 'cfo', after_id: 'm_1', pending_ids: ['m_1'] } }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.errors_count, 1);
  assert.equal(JSON.stringify(result.output).includes('sensitive backend body omitted'), false);
  assert.equal(result.output.dry_run, true);
});

test('compiled entrypoint executes under a native absolute Windows script path and rejects invalid agent', { skip: !existsSync('dist/search/historical-repair-cli.js') }, () => {
  const compiled = path.resolve('dist/search/historical-repair-cli.js');
  const run = spawnSync(process.execPath, [compiled, '--agent', 'INVALID'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { mode: 'historical-reconciliation', complete: false, errors_count: 1, error: 'repair_cli_failed' });
});

test('repair drains a legacy multi-page pending backlog before opening a new source page', async () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, agent: 'cfo', kind: 'fact', text: id, tags: [], created_at: '2026-09-01T00:00:00Z' }));
  let scans = 0;
  let checkpoint = { version: 'memory-index-repair-v1' as const, agent: 'cfo', after_id: 'prior', pending_ids: rows.map(row => row.id) };
  for (let pass = 0; pass < 3; pass += 1) {
    const deps = {
      queryDocs: (async (_coll: string, query: string, params: Array<{ name: string; value: unknown }>) => {
        if (query.includes('c.id >')) { scans += 1; return []; }
        const id = params.find(item => item.name === '@id')?.value;
        return rows.filter(row => row.id === id);
      }) as unknown as typeof import('../agentstate/store.js').queryDocs,
      embedBatch: (async (texts: string[]) => texts.map(() => [1])) as unknown as typeof import('../azure/foundry.js').embedBatch,
      embed: (async () => [1]) as unknown as typeof import('../azure/foundry.js').embed,
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('_mget')) { const ids = (JSON.parse(String(init?.body)).ids as string[]); return new Response(JSON.stringify({ docs: ids.map(_id => ({ _id, found: false })) }), { status: 200 }); }
      if (url.includes('_bulk')) return new Response(JSON.stringify({ errors: false, items: [{ index: { status: 201 } }] }), { status: 200 });
      throw new Error('unexpected');
    }) as unknown as typeof fetch;
    try { checkpoint = (await runHistoricalRepair({ agent: 'cfo', max: 1, checkpoint }, deps)).checkpoint; } finally { globalThis.fetch = original; }
    assert.equal(checkpoint.after_id, 'prior');
    assert.equal(checkpoint.pending_ids.length, 2 - pass);
  }
  assert.equal(scans, 0);
});
