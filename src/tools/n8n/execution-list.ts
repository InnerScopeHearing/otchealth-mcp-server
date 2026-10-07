import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import {
  listExecutions,
  N8N_EXECUTION_LIST_MAX_CURSOR_CHARS,
  N8N_EXECUTION_LIST_MAX_LIMIT,
  N8N_EXECUTION_LIST_MAX_PAGES,
  N8N_EXECUTION_LIST_SCAN_BUDGET_MS,
  type ListExecutionsArgs,
  validateListExecutionsArgs,
} from '../../n8n/full-client.js';

export const N8N_EXECUTION_LIST_INPUT_SHAPE = {
  started_after: z
    .string()
    .datetime({ offset: true })
    .describe('Inclusive ISO 8601 start bound. The requested window must be no longer than 31 days.'),
  started_before: z
    .string()
    .datetime({ offset: true })
    .describe('Inclusive ISO 8601 end bound. The requested window must be no longer than 31 days.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(N8N_EXECUTION_LIST_MAX_LIMIT)
    .describe('Page size for each upstream request, from 1 to 100. Larger pages cover more executions per scan.'),
};

const executionListInputSchema = z.object(N8N_EXECUTION_LIST_INPUT_SHAPE).strict();

const executionStatusKeys = ['success', 'error', 'waiting', 'running', 'other'] as const;
type ExecutionStatusKey = (typeof executionStatusKeys)[number];
type ExecutionStatusCounts = Record<ExecutionStatusKey, number>;

export interface ExecutionCountSummary {
  /** Executions whose startedAt falls inside the window. */
  observed_count: number;
  counts_by_status: ExecutionStatusCounts;
  /** True when the scan hit its page or time cap before reaching the window start: counts are a lower bound. */
  truncated: boolean;
  /** Executions examined across all pages, inside or outside the window. */
  scanned_count: number;
}

export interface ExecutionWindow {
  afterMs: number;
  beforeMs: number;
}

export interface ExecutionPageScan {
  observed: number;
  scanned: number;
  /** Every placeable execution on this page started before the window: nothing older can matter. */
  allBeforeWindow: boolean;
  nextCursor: string | null;
}

type ExecutionLister = (args: ListExecutionsArgs) => Promise<unknown>;

export function isN8nExecutionListAllowed(callerAgent: string): boolean {
  return callerAgent === 'cto';
}

function invalidResponse(): never {
  throw new Error('n8n_execution_list_invalid_response');
}

function newCounts(): ExecutionStatusCounts {
  return { success: 0, error: 0, waiting: 0, running: 0, other: 0 };
}

/**
 * Validate one upstream page and fold the executions that started inside the window into `counts`.
 * Only each execution's status and startedAt are ever read; ids, workflow names and payloads are
 * never touched. Fails closed on any malformed page.
 */
export function scanExecutionPage(
  raw: unknown,
  limit: number,
  window: ExecutionWindow,
  counts: ExecutionStatusCounts,
): ExecutionPageScan {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalidResponse();
  const response = raw as { data?: unknown; nextCursor?: unknown };
  if (!Array.isArray(response.data) || response.data.length > limit) return invalidResponse();
  if (!Object.prototype.hasOwnProperty.call(response, 'nextCursor')) return invalidResponse();
  const next = response.nextCursor;
  if (next !== null && (typeof next !== 'string' || next.length === 0 || next.length > N8N_EXECUTION_LIST_MAX_CURSOR_CHARS)) {
    return invalidResponse();
  }

  let observed = 0;
  let placed = 0;
  let before = 0;
  for (const execution of response.data) {
    if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) return invalidResponse();
    const { status, startedAt } = execution as { status?: unknown; startedAt?: unknown };
    if (typeof status !== 'string' || status.length === 0 || status.length > 32) return invalidResponse();
    // An execution that never started (queued/new) has no startedAt and cannot be placed in a window.
    const startedMs = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
    if (!Number.isFinite(startedMs)) continue;
    placed += 1;
    if (startedMs < window.afterMs) {
      before += 1;
      continue;
    }
    if (startedMs > window.beforeMs) continue;
    const key = status.toLowerCase();
    counts[(executionStatusKeys as readonly string[]).includes(key) ? (key as ExecutionStatusKey) : 'other'] += 1;
    observed += 1;
  }
  return { observed, scanned: response.data.length, allBeforeWindow: placed > 0 && before === placed, nextCursor: next };
}

/**
 * The n8n public API cannot filter executions by date (it rejects startedAfter/startedBefore with a
 * 400), so the window is applied here: newest-first pages are scanned, executions newer than the
 * window are skipped, executions inside it are counted, and the scan stops at the first page that
 * lies entirely before it. The scan is hard-capped (pages and wall clock); hitting a cap before the
 * window start reports truncated=true.
 */
export async function getN8nExecutionCountSummary(
  rawInput: unknown,
  ctx: Pick<ToolContext, 'callerAgent' | 'correlationId'>,
  list: ExecutionLister = listExecutions,
  now: () => number = Date.now,
): Promise<ExecutionCountSummary> {
  if (!isN8nExecutionListAllowed(ctx.callerAgent)) {
    throw new Error('n8n_execution_list_forbidden');
  }

  const parsed = executionListInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error('n8n_execution_list_invalid_input');

  const base: ListExecutionsArgs = {
    startedAfter: parsed.data.started_after,
    startedBefore: parsed.data.started_before,
    limit: parsed.data.limit,
    correlationId: ctx.correlationId,
  };
  try {
    validateListExecutionsArgs(base);
  } catch {
    throw new Error('n8n_execution_list_invalid_input');
  }

  const window: ExecutionWindow = { afterMs: Date.parse(base.startedAfter), beforeMs: Date.parse(base.startedBefore) };
  const counts = newCounts();
  const deadline = now() + N8N_EXECUTION_LIST_SCAN_BUDGET_MS;
  let observed = 0;
  let scanned = 0;
  let truncated = false;
  let cursor: string | undefined;
  for (let page = 1; ; page += 1) {
    let raw: unknown;
    try {
      raw = await list(cursor === undefined ? base : { ...base, cursor });
    } catch {
      // Upstream errors can retain the original response body. Keep that body and its message out of
      // the tool result and audit record.
      throw new Error('n8n_execution_list_request_failed');
    }
    const scan = scanExecutionPage(raw, base.limit, window, counts);
    observed += scan.observed;
    scanned += scan.scanned;
    if (scan.nextCursor === null || scan.allBeforeWindow) break;
    // An upstream that repeats its cursor would loop until the caps; fail closed instead.
    if (scan.nextCursor === cursor) return invalidResponse();
    if (page >= N8N_EXECUTION_LIST_MAX_PAGES || now() >= deadline) {
      truncated = true;
      break;
    }
    cursor = scan.nextCursor;
  }
  return { observed_count: observed, counts_by_status: counts, truncated, scanned_count: scanned };
}

export function registerN8nExecutionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_execution_list',
      category: 'read',
      annotations: {
        title: 'Count n8n executions in a bounded date window',
        description:
          'Return aggregate counts by execution status for one explicit date window of at most 31 days. ' +
          'Requires started_after, started_before, and a page-size limit from 1 to 100. The n8n API cannot filter by date, ' +
          `so newest-first pages are scanned (at most ${N8N_EXECUTION_LIST_MAX_PAGES} pages or ${N8N_EXECUTION_LIST_SCAN_BUDGET_MS / 1000}s) and ` +
          'executions are counted by their start time; truncated=true means the scan stopped before reaching the window start, so counts are a lower bound. ' +
          'The CTO lane only can use this tool. Execution IDs, workflow names and definitions, payloads, prompts, and customer content are never returned.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: N8N_EXECUTION_LIST_INPUT_SHAPE,
      outputShape: {
        observed_count: z.number().int().nonnegative(),
        counts_by_status: z.object({
          success: z.number().int().nonnegative(),
          error: z.number().int().nonnegative(),
          waiting: z.number().int().nonnegative(),
          running: z.number().int().nonnegative(),
          other: z.number().int().nonnegative(),
        }).strict(),
        truncated: z.boolean(),
        scanned_count: z.number().int().nonnegative(),
      },
      handler: async (input, ctx) => {
        const summary = await getN8nExecutionCountSummary(input, ctx);
        return {
          data: summary,
          summary:
            `Counted ${summary.observed_count} execution(s) in the window (scanned ${summary.scanned_count})` +
            (summary.truncated ? '; scan truncated before the window start, counts are a lower bound.' : '.'),
        };
      },
    },
    callerHash,
  );
}
