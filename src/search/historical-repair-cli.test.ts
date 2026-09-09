import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { HISTORICAL_REPAIR_RUNTIME_CONTRACT, parseHistoricalRepairArgs, runHistoricalRepairCli } from './historical-repair-cli.js';
import { runHistoricalRepair } from './opensearch-backfill.js';

// Required configuration uses synthetic values in this isolated test process. All HTTP is stubbed.
for (const name of ['CIO_SITE_ID', 'CIO_TRACK_KEY', 'CIO_APP_API_BEARER', 'FOUNDRY_KEY']) process.env[name] = 'synthetic-test';
for (const name of ['PERPLEXITY_CONNECTOR_TOKEN', 'ADMIN_REVOKE_TOKEN', 'N8N_WEBHOOK_SECRET']) process.env[name] = 'x'.repeat(32);
process.env.FOUNDRY_OPENAI_ENDPOINT = 'https://synthetic.example.invalid';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.EMBEDDINGS_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'synthetic-key';

test('repair CLI defaults to dry run and rejects unbounded or malformed options', () => {
  assert.equal(parseHistoricalRepairArgs(['--agent', 'cfo', '--max', '25']).dryRun, true);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--max', '201']), /max_invalid/);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--unknown', 'x']), /args_invalid/);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--durable', '--checkpoint', '{}']), /args_invalid/);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--preflight']), /args_invalid/);
  assert.throws(() => parseHistoricalRepairArgs(['--agent', 'cfo', '--durable', '--preflight', '--execute']), /args_invalid/);
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
  assert.deepEqual(JSON.parse(run.stdout), { runtime_contract: HISTORICAL_REPAIR_RUNTIME_CONTRACT, mode: 'historical-reconciliation', complete: false, errors_count: 1, error: 'repair_cli_failed' });
});

test('durable preflight reads only checkpoint metadata and never calls the repair engine', async () => {
  let runs = 0;
  let saves = 0;
  const result = await runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--preflight', '--max', '25'],
    async () => { runs += 1; throw new Error('repair engine must not run'); },
    {
      load: async () => ({ exists: true, etag: 'etag-1', checkpoint: { version: 'memory-index-repair-v1', agent: 'cfo', after_id: 'm_2', pending_ids: ['m_1'] } }),
      acquire: async () => { throw new Error('preflight must not acquire'); },
      renew: async () => { throw new Error('preflight must not renew'); },
      commit: async () => { saves += 1; return true; },
      release: async () => true,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ready, true);
  assert.equal(result.output.pending_count, 1);
  assert.equal('checkpoint' in result.output, false);
  assert.equal(runs, 0);
  assert.equal(saves, 0);
});

test('compiled preflight needs no gateway-only credentials', { skip: !existsSync('dist/search/historical-repair-cli.js') }, () => {
  const compiled = path.resolve('dist/search/historical-repair-cli.js');
  const run = spawnSync(process.execPath, [compiled, '--agent', 'cfo', '--index', 'memory-exec', '--max', '25', '--durable', '--preflight'], {
    encoding: 'utf8', timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      STATE_BACKEND: 'postgres', PG_HOST: '127.0.0.1', PG_PORT: '1', PG_DATABASE: 'agentstate',
      PG_USER: 'worker', PG_PASSWORD: 'synthetic-password', PG_SSL_VERIFY: 'true',
      SEARCH_BACKEND: 'opensearch', OPENSEARCH_ENDPOINT: 'search.example.invalid',
      OPENSEARCH_REGION: 'us-east-1', EMBEDDINGS_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic-key',
    },
  });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).error, 'checkpoint_store_unavailable');
  assert.equal(run.stdout.includes('CIO_SITE_ID'), false);
});

test('durable preflight reports a fixed checkpoint-store taxonomy without leaking an error body', async () => {
  const result = await runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--preflight'],
    async () => { throw new Error('repair engine must not run'); },
    {
      load: async () => { throw new Error('sensitive transport error body'); },
      acquire: async () => { throw new Error('not reached'); },
      renew: async () => null,
      commit: async () => false,
      release: async () => false,
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, 'checkpoint_store_unavailable');
  assert.equal(JSON.stringify(result.output).includes('sensitive transport error body'), false);
});

test('durable preflight distinguishes a validated state-plane configuration failure', async () => {
  const result = await runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--preflight'],
    async () => { throw new Error('repair engine must not run'); },
    {
      load: async () => { throw new Error('agentstate_runtime_config_invalid'); },
      acquire: async () => { throw new Error('not reached'); },
      renew: async () => null,
      commit: async () => false,
      release: async () => false,
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, 'checkpoint_store_configuration_invalid');
});

test('durable dry run resumes the saved cursor without advancing durable state', async () => {
  const saved = { version: 'memory-index-repair-v1' as const, agent: 'cfo', after_id: 'm_2', pending_ids: ['m_1'] };
  let observedCheckpoint: unknown;
  let saves = 0;
  const result = await runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--max', '25'],
    async options => {
      observedCheckpoint = options.checkpoint;
      return { mode: 'historical-reconciliation', index: 'memory-exec', since: 'm_2', fetched: 1, indexed: 0, failed: 0, truncated: true, dryRun: true, errors: [], checked: 1, already_indexed: 0, checkpoint: { ...saved, after_id: 'm_3' } };
    },
    {
      load: async () => ({ exists: true, etag: 'etag-1', checkpoint: saved }),
      acquire: async () => { throw new Error('dry run must not acquire'); },
      renew: async () => { throw new Error('dry run must not renew'); },
      commit: async () => { saves += 1; return true; },
      release: async () => true,
    },
  );
  assert.deepEqual(observedCheckpoint, saved);
  assert.equal(result.output.checkpoint_persisted, false);
  assert.equal('checkpoint' in result.output, false);
  assert.equal(saves, 0);
});

test('durable execute advances state only after the pass and fails closed on CAS conflict', async () => {
  const terminal = { version: 'memory-index-repair-v1' as const, agent: 'cfo', after_id: 'm_9', pending_ids: [] };
  const run = async () => ({ mode: 'historical-reconciliation' as const, index: 'memory-exec', since: 'm_8', fetched: 0, indexed: 0, failed: 0, truncated: false, dryRun: false, errors: [], checked: 0, already_indexed: 0, checkpoint: terminal });
  for (const [persisted, expectedExit] of [[true, 0], [false, 1]] as const) {
    let commits = 0;
    const result = await runHistoricalRepairCli(
      ['--agent', 'cfo', '--durable', '--execute'],
      run,
      {
        load: async () => ({ exists: false }),
        acquire: async (agent, index, runId) => ({
          acquired: true, agent, index, run_id: runId, etag: 'etag-lease', expires_at: '2030-01-01T00:00:00.000Z',
          previous_completed_run_id: null,
        }),
        renew: async lease => lease,
        commit: async (_lease, value) => { commits += 1; assert.deepEqual(value, terminal); return persisted; },
        release: async () => true,
      },
    );
    assert.equal(result.exitCode, expectedExit);
    assert.equal(result.output.checkpoint_persisted, persisted);
    assert.equal(result.output.complete, persisted);
    assert.equal(result.output.errors_count, persisted ? 0 : 1);
    assert.equal(commits, 1);
  }
});

test('durable execute refuses an overlapping worker before the repair engine runs', async () => {
  let runs = 0;
  const result = await runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--execute'],
    async () => { runs += 1; throw new Error('must not run'); },
    {
      load: async () => ({ exists: true, lease_active: true }),
      acquire: async () => ({ acquired: false }),
      renew: async () => null,
      commit: async () => true,
      release: async () => true,
    },
  );
  assert.equal(runs, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, 'repair_already_running');
});

test('durable execute releases its lease when the engine throws', async () => {
  let releases = 0;
  await assert.rejects(() => runHistoricalRepairCli(
    ['--agent', 'cfo', '--durable', '--execute'],
    async () => { throw new Error('synthetic engine failure'); },
    {
      load: async () => ({ exists: false }),
      acquire: async (agent, index, runId) => ({ acquired: true, agent, index, run_id: runId, etag: 'etag-lease', expires_at: '2030-01-01T00:00:00.000Z', previous_completed_run_id: null }),
      renew: async lease => lease,
      commit: async () => true,
      release: async () => { releases += 1; return true; },
    },
  ), /synthetic engine failure/);
  assert.equal(releases, 1);
});

test('repair drains a legacy multi-page pending backlog before opening a new source page', async () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, agent: 'cfo', kind: 'fact', text: id, tags: [], created_at: '2026-09-01T00:00:00Z' }));
  let scans = 0;
  const priorAccess = process.env.AWS_ACCESS_KEY_ID;
  const priorSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const priorEndpoint = process.env.OPENSEARCH_ENDPOINT;
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  process.env.OPENSEARCH_ENDPOINT = 'search-test.example.invalid';
  let checkpoint = { version: 'memory-index-repair-v1' as const, agent: 'cfo', after_id: 'prior', pending_ids: rows.map(row => row.id) };
  try { for (let pass = 0; pass < 3; pass += 1) {
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
  } finally {
    if (priorAccess === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = priorAccess;
    if (priorSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = priorSecret;
    if (priorEndpoint === undefined) delete process.env.OPENSEARCH_ENDPOINT; else process.env.OPENSEARCH_ENDPOINT = priorEndpoint;
  }
});
