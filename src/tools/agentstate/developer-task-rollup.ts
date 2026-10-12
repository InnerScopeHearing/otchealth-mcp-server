import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { listTasks, type Task, type TaskListFilter } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';
import { canReadPersonalTasks, taskVisibleToCaller } from './task-read-access.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface DeveloperTaskRollupInput {
  board?: string;
  limit?: number;
}

export interface DeveloperTaskRollupDeps {
  isConfigured: () => boolean;
  listTasks: (filter: TaskListFilter) => Promise<Task[]>;
  now?: () => Date;
}

const DEFAULT_DEPS: DeveloperTaskRollupDeps = { isConfigured, listTasks };

type UnavailableError = 'ledger_not_configured' | 'provider_read_failed' | 'caller_not_authorized' | 'invalid_input';

function unavailable(error: UnavailableError): ToolResultPayload {
  const summary = {
    ledger_not_configured: 'Task ledger is not configured.',
    caller_not_authorized: 'This rollup is available only to the Developer lane.',
    invalid_input: 'Task rollup input is invalid.',
    provider_read_failed: 'Task ledger read failed.',
  }[error];
  return { data: { available: false, error }, summary, compactJsonText: true };
}

function validTaskRow(value: unknown): value is Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<Task>;
  return typeof row.id === 'string' && row.id.length > 0 &&
    typeof row.owner_agent === 'string' && typeof row.board === 'string' &&
    typeof row.status === 'string' && typeof row.updated_at === 'string' &&
    typeof row.created_by === 'string';
}

/**
 * Aggregate the newest bounded source result for the authenticated Developer. `listTasks` is
 * asked for at most `limit` rows. A short result proves exhaustion under the ledger list contract;
 * a full result is ambiguous because the adapter exposes no continuation/exhaustion proof. The
 * response reports facts about this page only and never promotes a full page to board totals.
 */
export async function handleDeveloperTaskRollup(
  input: DeveloperTaskRollupInput,
  ctx: Pick<ToolContext, 'callerAgent'>,
  deps: DeveloperTaskRollupDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  try {
    if (!deps.isConfigured()) return unavailable('ledger_not_configured');

    const owner = (ctx.callerAgent || '').trim().toLowerCase();
    if (owner !== 'developer') return unavailable('caller_not_authorized');
    const requestedLimit = input.limit ?? DEFAULT_LIMIT;
    const requestedBoard = input.board === undefined ? 'fleet' : input.board.trim().toLowerCase();
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_LIMIT ||
      !requestedBoard || requestedBoard.length > 100) {
      return unavailable('invalid_input');
    }

    const tasks = await deps.listTasks({
      owner_agent: owner,
      board: requestedBoard,
      limit: requestedLimit,
      exclude_personal_legal: !canReadPersonalTasks(owner),
    });
    if (!Array.isArray(tasks)) return unavailable('provider_read_failed');

    // Cap malformed adapters locally as well as at the storage query boundary. A response above
    // the requested cap is an anomaly and cannot support a complete-page claim.
    const sourcePageCount = tasks.length;
    const overflow = sourcePageCount > requestedLimit;
    const boundedRows = tasks.slice(0, requestedLimit);
    const groups = new Map<string, { count: number; task_ids: string[] }>(
      TASK_STATUSES.map((status) => [status, { count: 0, task_ids: [] }]),
    );
    const seenIds = new Map<string, string>();
    const ambiguousIds = new Set<string>();
    let latestUpdatedAt: string | undefined;
    let latestUpdatedMs = Number.NEGATIVE_INFINITY;
    let invalidRows = 0;
    let duplicateIds = 0;
    let conflictingDuplicateIds = 0;
    let invalidTimestamps = 0;
    let filteredRows = 0;

    for (const candidate of boundedRows as unknown[]) {
      if (!validTaskRow(candidate)) {
        invalidRows++;
        continue;
      }
      const task = candidate;
      const taskOwner = task.owner_agent.trim().toLowerCase();
      const taskBoard = task.board.trim().toLowerCase();
      if (taskOwner !== owner || taskBoard !== requestedBoard || !taskVisibleToCaller(task, owner)) {
        filteredRows++;
        continue;
      }
      // Timestamp observation describes valid rows present on the page, including duplicates that
      // are excluded from count membership. Otherwise a later duplicate could be silently missed.
      const updatedMs = Date.parse(task.updated_at);
      if (Number.isFinite(updatedMs) && updatedMs > latestUpdatedMs) {
        latestUpdatedMs = updatedMs;
        latestUpdatedAt = task.updated_at;
      } else if (!Number.isFinite(updatedMs)) {
        invalidTimestamps++;
      }
      if (seenIds.has(task.id)) {
        duplicateIds++;
        if (seenIds.get(task.id) !== task.status) {
          conflictingDuplicateIds++;
          // Conflicting duplicate rows cannot safely contribute to either status. Remove the
          // earlier observation too, so the rollup does not pick an arbitrary winner.
          const priorStatus = seenIds.get(task.id)!;
          const priorGroup = groups.get(priorStatus);
          if (priorGroup) {
            priorGroup.count--;
            priorGroup.task_ids = priorGroup.task_ids.filter((id) => id !== task.id);
          }
          seenIds.delete(task.id);
          ambiguousIds.add(task.id);
        }
        continue;
      }
      if (ambiguousIds.has(task.id)) continue;
      seenIds.set(task.id, task.status);

      const status = task.status;
      const group = groups.get(status) ?? { count: 0, task_ids: [] };
      group.count++;
      group.task_ids.push(task.id);
      groups.set(status, group);

    }

    const sourceAnomalies = [
      ...(overflow ? ['source_limit_exceeded'] : []),
      ...(invalidRows ? ['invalid_source_rows'] : []),
      ...(duplicateIds ? ['duplicate_source_ids'] : []),
      ...(conflictingDuplicateIds ? ['conflicting_duplicate_statuses'] : []),
      ...(invalidTimestamps ? ['invalid_source_timestamps'] : []),
      ...(filteredRows ? ['out_of_scope_rows_filtered'] : []),
    ];
    const possiblyTruncated = sourcePageCount >= requestedLimit || sourceAnomalies.length > 0;
    const countsAreComplete = !possiblyTruncated;
    const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    const statusCounts = Object.fromEntries(sortedGroups.map(([status, value]) => [status, value.count]));
    const sourceTaskIds = Object.fromEntries(sortedGroups.map(([status, value]) => [status, value.task_ids]));

    return {
      data: {
        available: true,
        observed_at: (deps.now?.() ?? new Date()).toISOString(),
        ...(latestUpdatedAt ? { max_observed_updated_at: latestUpdatedAt } : {}),
        scope: {
          board: requestedBoard,
          owner_agent: owner,
          returned_count: seenIds.size,
          source_page_count: Math.min(sourcePageCount, requestedLimit),
          requested_limit: requestedLimit,
          possibly_truncated: possiblyTruncated,
          counts_are_complete: countsAreComplete,
          completeness_reason: sourceAnomalies.length > 0 ? 'source_anomaly' :
            possiblyTruncated ? 'limit_reached' : 'source_exhausted',
          source_anomalies: sourceAnomalies,
        },
        status_counts: statusCounts,
        source_task_ids: sourceTaskIds,
      },
      compactJsonText: true,
    };
  } catch {
    // Provider exceptions often contain endpoint details, query text, or data. Never forward them.
    return unavailable('provider_read_failed');
  }
}

export function registerDeveloperTaskRollup(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'developer_task_rollup',
      category: 'read',
      annotations: {
        title: 'Summarize your work-ledger tasks',
        description: 'Return bounded status counts and source task IDs for tasks owned by the authenticated Developer. Raw task rows and task contents are not returned. Counts cover only the newest bounded page; a full page is marked as possibly truncated. Personal-legal visibility follows the existing task ledger ring.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        board: z.string().min(1).max(100).optional().describe('Board partition (default "fleet").'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Newest tasks to aggregate (default 50, max 200).'),
      },
      outputShape: {
        available: z.boolean(),
        error: z.string().optional(),
        observed_at: z.string().optional(),
        max_observed_updated_at: z.string().optional(),
        scope: z.unknown().optional(),
        status_counts: z.record(z.number()).optional(),
        source_task_ids: z.record(z.array(z.string())).optional(),
      },
      handler: handleDeveloperTaskRollup,
    },
    callerHash,
  );
}
