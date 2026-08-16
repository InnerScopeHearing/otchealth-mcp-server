#!/usr/bin/env tsx
/**
 * CLI wrapper for src/search/opensearch-backfill.ts -- catches the OpenSearch `memory-exec` index up
 * with the durable Cosmos/Postgres memory-of-record. See that module's doc comment for full design
 * rationale. This file is a thin argv-parsing + printing shell; all real logic lives in the (fully
 * typechecked + unit-tested) src/search module, imported here as compiled TS via tsx.
 *
 * Run (the exact command for the 2026-08-13 AWS-cutover catch-up -- auto-detects the watermark from
 * the index's own newest doc, which for the frozen room IS 2026-08-13T22:03:02.473Z, so an explicit
 * --since is not required, but may be passed to re-run from a specific point):
 *
 *   npx tsx scripts/opensearch-backfill.ts
 *
 * Preview first, without writing anything:
 *
 *   npx tsx scripts/opensearch-backfill.ts --dry-run
 *
 * Options:
 *   --index <name>        target OpenSearch index (default: memory-exec)
 *   --since <iso8601>      explicit cutoff; omit to auto-detect from the index's newest document
 *   --agent <id>            scope to one agent's Cosmos/Postgres partition (recommended re-run
 *                           option if a prior run reported truncated:true)
 *   --max <n>               row cap for the single query this run issues (default 5000)
 *   --embed-batch-size <n>  texts per embedBatch() call (default 16)
 *   --bulk-batch-size <n>   docs per OpenSearch _bulk request (default 48)
 *   --dry-run               fetch + preview only; embeds and writes nothing
 *
 * Requires the SAME environment this gateway runs under: OPENSEARCH_ENDPOINT/OPENSEARCH_REGION +
 * AWS credentials (env vars or the ECS task role), the STATE_BACKEND's store credentials
 * (COSMOS_ENDPOINT/COSMOS_KEY or PG_*), and EMBEDDINGS_PROVIDER's credentials (FOUNDRY_* or
 * OPENAI_API_KEY). Exits 0 on a clean, complete run; 1 if anything failed to index, the fetch was
 * truncated (re-run needed), or a hard error prevented the run from starting at all -- so this is
 * safe to wire into a scheduled/CI-gated reconciler job, not only a one-off manual catch-up.
 */
import { runBackfill } from '../src/search/opensearch-backfill.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const opts = {
    index: arg('--index'),
    since: arg('--since'),
    agent: arg('--agent'),
    max: arg('--max') ? Number(arg('--max')) : undefined,
    embedBatchSize: arg('--embed-batch-size') ? Number(arg('--embed-batch-size')) : undefined,
    bulkBatchSize: arg('--bulk-batch-size') ? Number(arg('--bulk-batch-size')) : undefined,
    dryRun: flag('--dry-run'),
  };

  const result = await runBackfill(opts);
  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length && result.fetched === 0 && result.indexed === 0 && result.failed === 0) {
    // The "refused to run" shape (no resolvable `since`, or the store query itself failed outright).
    console.error(`opensearch-backfill: did not run -- ${result.errors[0]}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `opensearch-backfill: index=${result.index} since=${result.since} fetched=${result.fetched} indexed=${result.indexed} failed=${result.failed}` +
      `${result.truncated ? ' TRUNCATED (re-run: narrow with --agent, or re-run once this batch is indexed and a fresh auto-detect will pick up the rest)' : ''}` +
      `${result.dryRun ? ' [DRY RUN -- nothing written]' : ''}`,
  );
  if (result.failed > 0 || result.truncated) process.exitCode = 1;
}

main().catch((e) => {
  console.error('opensearch-backfill: fatal error', e);
  process.exitCode = 1;
});
