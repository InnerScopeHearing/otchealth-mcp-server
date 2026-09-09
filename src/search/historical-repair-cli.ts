/** Production entrypoint for bounded historical memory repair.  It is compiled into dist and
 * deliberately defaults to preview mode.  Output contains operational counts and source IDs for
 * checkpoint resumption, never memory text, vectors, credentials, or backend error bodies. */
import { runHistoricalRepair, type HistoricalRepairCheckpoint, type HistoricalRepairResult } from './opensearch-backfill.js';
import path from 'node:path';

export type RepairCliOptions = Readonly<{ agent: string; index?: string; max?: number; embedBatchSize?: number; bulkBatchSize?: number; checkpoint?: HistoricalRepairCheckpoint; dryRun: boolean }>;
const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const SOURCE_ID = /^[A-Za-z0-9_.-]{1,255}$/;

function integer(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name}_invalid`);
  return parsed;
}

function checkpoint(raw: string | undefined, agent: string): HistoricalRepairCheckpoint | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('checkpoint_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checkpoint_invalid');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).sort().join(',') !== 'after_id,agent,pending_ids,version' || c.version !== 'memory-index-repair-v1' || c.agent !== agent || typeof c.after_id !== 'string' || !SOURCE_ID.test(c.after_id || 'x') || !Array.isArray(c.pending_ids) || c.pending_ids.some(id => typeof id !== 'string' || !SOURCE_ID.test(id))) throw new Error('checkpoint_invalid');
  return { version: 'memory-index-repair-v1', agent, after_id: c.after_id, pending_ids: [...new Set(c.pending_ids as string[])].sort() };
}

export function parseHistoricalRepairArgs(argv: string[]): RepairCliOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--execute') { if (execute) throw new Error('args_invalid'); execute = true; continue; }
    if (!['--agent', '--index', '--max', '--embed-batch-size', '--bulk-batch-size', '--checkpoint'].includes(flag) || values.has(flag) || !argv[i + 1]) throw new Error('args_invalid');
    values.set(flag, argv[++i]);
  }
  const agent = values.get('--agent');
  if (!agent || !ID.test(agent)) throw new Error('agent_invalid');
  const index = values.get('--index');
  if (index !== undefined && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(index)) throw new Error('index_invalid');
  return { agent, index, max: integer(values.get('--max'), 'max', 200), embedBatchSize: integer(values.get('--embed-batch-size'), 'embed_batch', 16), bulkBatchSize: integer(values.get('--bulk-batch-size'), 'bulk_batch', 48), checkpoint: checkpoint(values.get('--checkpoint'), agent), dryRun: !execute };
}

export function repairOutput(result: HistoricalRepairResult): Record<string, unknown> {
  return { mode: result.mode, agent: result.checkpoint.agent, index: result.index, dry_run: result.dryRun, checked: result.checked, already_indexed: result.already_indexed, fetched: result.fetched, indexed: result.indexed, failed: result.failed, truncated: result.truncated, errors_count: result.errors.length, pending_count: result.checkpoint.pending_ids.length, complete: !result.dryRun && result.failed === 0 && !result.truncated && result.errors.length === 0 && result.checkpoint.pending_ids.length === 0, checkpoint: result.checkpoint };
}

export async function runHistoricalRepairCli(argv: string[], run = runHistoricalRepair): Promise<{ output: Record<string, unknown>; exitCode: number }> {
  const options = parseHistoricalRepairArgs(argv);
  const result = await run(options);
  const output = repairOutput(result);
  return { output, exitCode: output.complete === true ? 0 : 1 };
}

async function main(): Promise<void> {
  try {
    const result = await runHistoricalRepairCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.output)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    // Intentionally do not serialize an arbitrary Error message, which could carry a transport body.
    process.stdout.write(`${JSON.stringify({ mode: 'historical-reconciliation', complete: false, errors_count: 1, error: 'repair_cli_failed' })}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && (path.basename(process.argv[1]) === 'historical-repair-cli.js' || path.win32.basename(process.argv[1]) === 'historical-repair-cli.js');
if (invoked) void main();
