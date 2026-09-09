import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseHistoricalRepairArgs, runHistoricalRepairCli } from './historical-repair-cli.js';

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

test('compiled entrypoint executes under a Windows-style script argument and rejects invalid agent', { skip: !existsSync('dist/search/historical-repair-cli.js') }, () => {
  const run = spawnSync(process.execPath, ['dist\\search\\historical-repair-cli.js', '--agent', 'INVALID'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.deepEqual(JSON.parse(run.stdout), { mode: 'historical-reconciliation', complete: false, errors_count: 1, error: 'repair_cli_failed' });
});
