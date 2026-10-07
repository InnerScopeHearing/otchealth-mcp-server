import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import {
  isN8nExecutionPageTimeout,
  listExecutions,
  N8N_EXECUTION_LIST_MAX_CURSOR_CHARS,
  N8N_EXECUTION_LIST_MAX_LIMIT,
  N8N_EXECUTION_LIST_MAX_PAGE_SIZE,
  N8N_EXECUTION_LIST_MAX_PAGES,
  N8N_EXECUTION_LIST_MIN_PAGE_SIZE,
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
    .describe(
      'Requested page size, from 1 to 100. n8n is never sent a page larger than ' +
        `${N8N_EXECUTION_LIST_MAX_PAGE_SIZE}: a larger limit is served as several pages, and a page that times out is ` +
        `retried once at half the size (never below ${N8N_EXECUTION_LIST_MIN_PAGE_SIZE}).`,
    ),
};

const executionListInputSchema = z.object(N8N_EXECUTION_LIST_INPUT_SHAPE).strict();

const executionStatusKeys = ['success', 'error', 'waiting', 'running', 'other'] as const;
type ExecutionStatusKey = (typeof executionStatusKeys)[number];
type ExecutionStatusCounts = Record<ExecutionStatusKey, number>;

/**
 * Why a scan stopped before the window start:
 *  - page_cap:     the page-count cap was reached;
 *  - time_budget:  the wall-clock budget ran out;
 *  - page_timeout: n8n timed out on a page again after it was retried at half the size.
 */
const truncationReasons = ['page_cap', 'time_budget', 'page_timeout'] as const;
export type ExecutionScanTruncationReason = (typeof truncationReasons)[number];

export interface ExecutionCountSummary {
  /** Executions whose startedAt falls inside the window. */
  observed_count: number;
  counts_by_status: ExecutionStatusCounts;
  /**
   * True when the scan stopped before reaching the window start (page cap, time budget, or an n8n
   * page that kept timing out): counts cover only the newest part of the window and are a lower bound.
   */
  truncated: boolean;
  /** Executions examined across all pages, inside or outside the window. */
  scanned_count: number;
  /** Why the scan stopped early. Present only when truncated is true. */
  truncated_reason?: ExecutionScanTruncationReason;
  /**
   * Page size in effect when the scan ended. Present only when it differs from the requested limit
   * (the page size is capped, and shrinks after a timeout).
   */
  effective_page_size?: number;
  /** Pages that timed out and were retried at a smaller size. Present only when above zero. */
  page_timeout_retries?: number;
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

/** `opts.deadlineAtMs` is the scan's absolute deadline: the lister must not run past it. */
type ExecutionLister = (args: ListExecutionsArgs, opts?: { deadlineAtMs?: number }) => Promise<unknown>;

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
 * Page size for the retry after a page timed out: half the size that failed, never below the floor
 * and never above the size that failed (a caller who asked for 5 keeps 5).
 */
export function nextPageSizeAfterTimeout(pageSize: number): number {
  return Math.min(pageSize, Math.max(N8N_EXECUTION_LIST_MIN_PAGE_SIZE, Math.floor(pageSize / 2)));
}

interface PageSizing {
  /** Size of the next upstream request. It only ever shrinks, so one slow page does not slow every later page. */
  pageSize: number;
  timeoutRetries: number;
}

type PageFetch = { raw: unknown } | { stoppedBy: 'time_budget' | 'page_timeout' };

/**
 * Fetch one page. If n8n times out, retry that same page (same cursor) ONCE at half the size, and
 * keep the smaller size for the pages after it. Returns why it gave up instead of throwing when the
 * time is gone or the retry also timed out, so the caller can hand back what was already gathered.
 * Every other failure (auth, 4xx/5xx, a malformed body, n8n offline) fails closed with the fixed
 * safe error: upstream errors can retain the original response body, so neither it nor its message
 * may reach the tool result or the audit record.
 */
async function fetchPage(
  list: ExecutionLister,
  base: ListExecutionsArgs,
  cursor: string | undefined,
  sizing: PageSizing,
  deadline: number,
  now: () => number,
): Promise<PageFetch> {
  let retried = false;
  for (;;) {
    const args: ListExecutionsArgs = { ...base, limit: sizing.pageSize, ...(cursor === undefined ? {} : { cursor }) };
    try {
      return { raw: await list(args, { deadlineAtMs: deadline }) };
    } catch (err) {
      if (!isN8nExecutionPageTimeout(err)) throw new Error('n8n_execution_list_request_failed');
    }
    if (now() >= deadline) return { stoppedBy: 'time_budget' };
    if (retried) return { stoppedBy: 'page_timeout' };
    retried = true;
    sizing.timeoutRetries += 1;
    sizing.pageSize = nextPageSizeAfterTimeout(sizing.pageSize);
  }
}

/**
 * The n8n public API cannot filter executions by date (it rejects startedAfter/startedBefore with a
 * 400), so the window is applied here: newest-first pages are scanned, executions newer than the
 * window are skipped, executions inside it are counted, and the scan stops at the first page that
 * lies entirely before it. The scan is hard-capped (pages and wall clock); hitting a cap before the
 * window start reports truncated=true.
 *
 * Page size: n8n is never asked for more than N8N_EXECUTION_LIST_MAX_PAGE_SIZE per page, so a
 * caller limit of 100 is served as pages of 50 (one page of 100 could outlast the per-page timeout).
 * A page that times out is retried once at half the size (floor N8N_EXECUTION_LIST_MIN_PAGE_SIZE);
 * if the time budget runs out, or the retry also times out, after at least one page was scanned,
 * the counts gathered so far are returned with truncated=true and a truncated_reason instead of an
 * error. With nothing gathered there is nothing to return, so that case fails with a fixed error.
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
  const sizing: PageSizing = { pageSize: Math.min(base.limit, N8N_EXECUTION_LIST_MAX_PAGE_SIZE), timeoutRetries: 0 };
  // n8n keeps the page size inside its cursor, so no later page can be larger than the first one.
  const maxPageRows = sizing.pageSize;
  let observed = 0;
  let scanned = 0;
  let pages = 0;
  let truncatedReason: ExecutionScanTruncationReason | undefined;
  let cursor: string | undefined;
  for (;;) {
    const fetched = await fetchPage(list, base, cursor, sizing, deadline, now);
    if ('stoppedBy' in fetched) {
      // Nothing scanned yet means nothing to report: fail rather than hand back zeros that read as "no executions".
      if (pages === 0) throw new Error('n8n_execution_list_page_timeout');
      truncatedReason = fetched.stoppedBy;
      break;
    }
    const scan = scanExecutionPage(fetched.raw, maxPageRows, window, counts);
    pages += 1;
    observed += scan.observed;
    scanned += scan.scanned;
    if (scan.nextCursor === null || scan.allBeforeWindow) break;
    // An upstream that repeats its cursor would loop until the caps; fail closed instead.
    if (scan.nextCursor === cursor) return invalidResponse();
    if (pages >= N8N_EXECUTION_LIST_MAX_PAGES) {
      truncatedReason = 'page_cap';
      break;
    }
    if (now() >= deadline) {
      truncatedReason = 'time_budget';
      break;
    }
    cursor = scan.nextCursor;
  }
  return {
    observed_count: observed,
    counts_by_status: counts,
    truncated: truncatedReason !== undefined,
    scanned_count: scanned,
    ...(truncatedReason === undefined ? {} : { truncated_reason: truncatedReason }),
    ...(sizing.pageSize === base.limit ? {} : { effective_page_size: sizing.pageSize }),
    ...(sizing.timeoutRetries === 0 ? {} : { page_timeout_retries: sizing.timeoutRetries }),
  };
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
          `executions are counted by their start time. Pages sent to n8n never exceed ${N8N_EXECUTION_LIST_MAX_PAGE_SIZE} (a larger limit is served as several pages), ` +
          `and a page that times out is retried once at half the size (minimum ${N8N_EXECUTION_LIST_MIN_PAGE_SIZE}). ` +
          'truncated=true means the scan stopped before reaching the window start (truncated_reason: page_cap, time_budget or page_timeout), so counts are a lower bound. ' +
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
        truncated_reason: z.enum(truncationReasons).optional(),
        effective_page_size: z.number().int().positive().optional(),
        page_timeout_retries: z.number().int().positive().optional(),
      },
      handler: async (input, ctx) => {
        const summary = await getN8nExecutionCountSummary(input, ctx);
        return {
          data: summary,
          summary:
            `Counted ${summary.observed_count} execution(s) in the window (scanned ${summary.scanned_count})` +
            (summary.truncated
              ? `; scan truncated before the window start (${summary.truncated_reason ?? 'unspecified'}), counts are a lower bound.`
              : '.'),
        };
      },
    },
    callerHash,
  );
}
