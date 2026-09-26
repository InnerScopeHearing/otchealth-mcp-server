import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext } from '../registry.js';
import {
  listExecutions,
  N8N_EXECUTION_LIST_MAX_LIMIT,
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
    .describe('Maximum executions inspected in this request, from 1 to 100.'),
};

const executionListInputSchema = z.object(N8N_EXECUTION_LIST_INPUT_SHAPE).strict();

const executionStatusKeys = ['success', 'error', 'waiting', 'running', 'other'] as const;
type ExecutionStatusCounts = Record<(typeof executionStatusKeys)[number], number>;

export interface ExecutionCountSummary {
  observed_count: number;
  counts_by_status: ExecutionStatusCounts;
  truncated: boolean;
}

type ExecutionLister = (args: ListExecutionsArgs) => Promise<unknown>;

export function isN8nExecutionListAllowed(callerAgent: string): boolean {
  return callerAgent === 'cto';
}

function invalidResponse(): never {
  throw new Error('n8n_execution_list_invalid_response');
}

export function summarizeExecutionPage(raw: unknown, limit: number): ExecutionCountSummary {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return invalidResponse();
  const response = raw as { data?: unknown; nextCursor?: unknown };
  if (!Array.isArray(response.data) || response.data.length > limit) return invalidResponse();
  if (
    response.nextCursor !== undefined &&
    response.nextCursor !== null &&
    typeof response.nextCursor !== 'string'
  ) {
    return invalidResponse();
  }

  const counts: ExecutionStatusCounts = { success: 0, error: 0, waiting: 0, running: 0, other: 0 };
  for (const execution of response.data) {
    if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) return invalidResponse();
    const status = (execution as { status?: unknown }).status;
    if (typeof status !== 'string' || status.length === 0 || status.length > 32) return invalidResponse();
    const normalizedStatus = status.toLowerCase();
    if (executionStatusKeys.includes(normalizedStatus as (typeof executionStatusKeys)[number])) {
      counts[normalizedStatus as keyof ExecutionStatusCounts] += 1;
    } else {
      counts.other += 1;
    }
  }

  return {
    observed_count: response.data.length,
    counts_by_status: counts,
    truncated: typeof response.nextCursor === 'string' && response.nextCursor.length > 0,
  };
}

export async function getN8nExecutionCountSummary(
  rawInput: unknown,
  ctx: Pick<ToolContext, 'callerAgent' | 'correlationId'>,
  list: ExecutionLister = listExecutions,
): Promise<ExecutionCountSummary> {
  if (!isN8nExecutionListAllowed(ctx.callerAgent)) {
    throw new Error('n8n_execution_list_forbidden');
  }

  const parsed = executionListInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error('n8n_execution_list_invalid_input');

  const args: ListExecutionsArgs = {
    startedAfter: parsed.data.started_after,
    startedBefore: parsed.data.started_before,
    limit: parsed.data.limit,
    correlationId: ctx.correlationId,
  };
  try {
    validateListExecutionsArgs(args);
  } catch {
    throw new Error('n8n_execution_list_invalid_input');
  }
  let raw: unknown;
  try {
    raw = await list(args);
  } catch {
    // Upstream errors can retain the original response body. Keep that body and its message out of
    // the tool result and audit record.
    throw new Error('n8n_execution_list_request_failed');
  }
  return summarizeExecutionPage(raw, parsed.data.limit);
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
          'Requires started_after, started_before, and a limit from 1 to 100. The CTO lane only can use this tool. ' +
          'Execution IDs, workflow names and definitions, payloads, prompts, and customer content are never returned.',
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
      },
      handler: async (input, ctx) => {
        const summary = await getN8nExecutionCountSummary(input, ctx);
        return {
          data: summary,
          summary: `Counted ${summary.observed_count} execution(s) in the bounded page.`,
        };
      },
    },
    callerHash,
  );
}
