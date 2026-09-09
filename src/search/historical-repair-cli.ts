/** Production entrypoint for bounded historical memory repair.  It is compiled into dist and
 * deliberately defaults to preview mode.  Output contains operational counts and source IDs for
 * checkpoint resumption, never memory text, vectors, credentials, or backend error bodies. */
import { runHistoricalRepair, type HistoricalRepairCheckpoint, type HistoricalRepairResult } from './opensearch-backfill.js';
import {
  historicalRepairCheckpointStore,
  normalizeHistoricalRepairCheckpoint,
  type HistoricalRepairCheckpointStore,
} from './historical-repair-checkpoint.js';
import crypto from 'node:crypto';
import path from 'node:path';

export type RepairCliOptions = Readonly<{ agent: string; index?: string; max?: number; embedBatchSize?: number; bulkBatchSize?: number; checkpoint?: HistoricalRepairCheckpoint; dryRun: boolean; durable: boolean; preflight: boolean }>;
export const HISTORICAL_REPAIR_RUNTIME_CONTRACT = 'historical-repair-durable-fenced-v2';
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function integer(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name}_invalid`);
  return parsed;
}

function checkpoint(raw: string | undefined, agent: string): HistoricalRepairCheckpoint | undefined {
  if (raw === undefined) return undefined;
  // Bound attacker-controlled argv memory without silently discarding any valid source ID.
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error('checkpoint_invalid');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('checkpoint_invalid'); }
  return normalizeHistoricalRepairCheckpoint(value, agent);
}

export function parseHistoricalRepairArgs(argv: string[]): RepairCliOptions {
  const values = new Map<string, string>();
  let execute = false;
  let durable = false;
  let preflight = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') { if (execute) throw new Error('args_invalid'); execute = true; continue; }
    if (flag === '--durable') { if (durable) throw new Error('args_invalid'); durable = true; continue; }
    if (flag === '--preflight') { if (preflight) throw new Error('args_invalid'); preflight = true; continue; }
    if (!['--agent', '--index', '--max', '--embed-batch-size', '--bulk-batch-size', '--checkpoint'].includes(flag) || values.has(flag) || !argv[i + 1]) throw new Error('args_invalid');
    values.set(flag, argv[++i]);
  }
  const agent = values.get('--agent');
  if (!agent || !ID.test(agent)) throw new Error('agent_invalid');
  const index = values.get('--index');
  if (index !== undefined && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(index)) throw new Error('index_invalid');
  if (durable && values.has('--checkpoint')) throw new Error('args_invalid');
  if (preflight && (!durable || execute)) throw new Error('args_invalid');
  return { agent, index, max: integer(values.get('--max'), 'max', 200), embedBatchSize: integer(values.get('--embed-batch-size'), 'embed_batch', 16), bulkBatchSize: integer(values.get('--bulk-batch-size'), 'bulk_batch', 48), checkpoint: checkpoint(values.get('--checkpoint'), agent), dryRun: !execute, durable, preflight };
}

export function repairOutput(result: HistoricalRepairResult): Record<string, unknown> {
  return { runtime_contract: HISTORICAL_REPAIR_RUNTIME_CONTRACT, mode: result.mode, agent: result.checkpoint.agent, index: result.index, dry_run: result.dryRun, checked: result.checked, already_indexed: result.already_indexed, fetched: result.fetched, indexed: result.indexed, failed: result.failed, truncated: result.truncated, errors_count: result.errors.length, pending_count: result.checkpoint.pending_ids.length, complete: !result.dryRun && result.failed === 0 && !result.truncated && result.errors.length === 0 && result.checkpoint.pending_ids.length === 0, checkpoint: result.checkpoint };
}

export async function runHistoricalRepairCli(
  argv: string[],
  run = runHistoricalRepair,
  store: HistoricalRepairCheckpointStore = historicalRepairCheckpointStore,
): Promise<{ output: Record<string, unknown>; exitCode: number }> {
  const options = parseHistoricalRepairArgs(argv);
  const index = options.index || 'memory-exec';
  const loaded = options.durable ? await store.load(options.agent, index) : { exists: false };
  if (options.preflight) {
    return {
      output: {
        runtime_contract: HISTORICAL_REPAIR_RUNTIME_CONTRACT,
        mode: 'historical-reconciliation',
        agent: options.agent,
        index,
        dry_run: true,
        preflight: true,
        checkpoint_store: 'agentstate-cache-cas',
        checkpoint_present: loaded.exists,
        lease_active: loaded.lease_active ?? false,
        pending_count: loaded.checkpoint?.pending_ids.length ?? 0,
        ready: loaded.lease_active !== true,
      },
      exitCode: loaded.lease_active === true ? 1 : 0,
    };
  }
  const lease = options.durable && !options.dryRun
    ? await store.acquire(options.agent, index, crypto.randomUUID())
    : undefined;
  if (lease && !lease.acquired) {
    return {
      output: {
        runtime_contract: HISTORICAL_REPAIR_RUNTIME_CONTRACT,
        mode: 'historical-reconciliation', agent: options.agent, index, dry_run: false,
        checkpoint_store: 'agentstate-cache-cas', checkpoint_persisted: false,
        complete: false, errors_count: 1, error: 'repair_already_running',
      },
      exitCode: 1,
    };
  }
  let activeLease = lease?.acquired ? lease : undefined;
  const beforePaidDispatch = activeLease ? async (): Promise<boolean> => {
    if (!activeLease) return false;
    const renewed = await store.renew(activeLease);
    if (!renewed) {
      activeLease = undefined;
      return false;
    }
    activeLease = renewed;
    return true;
  } : undefined;
  let result: HistoricalRepairResult;
  try {
    result = await run({ ...options, checkpoint: activeLease?.checkpoint ?? loaded.checkpoint ?? options.checkpoint, beforePaidDispatch });
  } catch (error) {
    if (activeLease) await store.release(activeLease).catch(() => false);
    throw error;
  }
  const output = repairOutput(result);
  if (options.durable) {
    delete output.checkpoint;
    output.checkpoint_store = 'agentstate-cache-cas';
    output.checkpoint_loaded = loaded.exists;
    output.checkpoint_persisted = false;
    if (!options.dryRun) {
      try {
        output.checkpoint_persisted = Boolean(activeLease) && await store.commit(activeLease!, result.checkpoint);
      } catch {
        output.checkpoint_persisted = false;
      }
      if (output.checkpoint_persisted !== true) {
        output.complete = false;
        output.errors_count = Number(output.errors_count) + 1;
      }
    }
  }
  return { output, exitCode: output.complete === true ? 0 : 1 };
}

async function main(): Promise<void> {
  try {
    const result = await runHistoricalRepairCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Intentionally do not serialize an arbitrary Error message, which could carry a transport body.
    process.stdout.write(`${JSON.stringify({ runtime_contract: HISTORICAL_REPAIR_RUNTIME_CONTRACT, mode: 'historical-reconciliation', complete: false, errors_count: 1, error: 'repair_cli_failed' })}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && (path.basename(process.argv[1]) === 'historical-repair-cli.js' || path.win32.basename(process.argv[1]) === 'historical-repair-cli.js');
if (invoked) void main();
