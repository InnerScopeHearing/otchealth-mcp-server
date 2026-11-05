import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, activeBackend, listTaskPage } from '../../agentstate/store.js';
import type { TaskPageQuery } from '../../agentstate/task-page-postgres.js';
import { taskPage } from './task-list-page.js';
import { listTasks, type Task, type TaskListFilter } from '../../agentstate/ledger.js';
import { TASK_STATUSES, normalizeAgent } from '../../agentstate/agents.js';
import { canReadPersonalTasks, projectTaskForCaller, taskVisibleToCaller } from './task-read-access.js';

export interface TaskListInput {
  owner_agent?: string;
  status?: TaskListFilter['status'];
  board?: string;
  limit?: number;
  view?: 'full' | 'summary';
  paginate?: boolean;
  cursor?: string;
}

export interface TaskListDeps {
  isConfigured: () => boolean;
  listTasks: (filter: TaskListFilter) => Promise<Task[]>;
  listTaskPage?: (input: TaskPageQuery) => Promise<Record<string, unknown>[]>;
  activeBackend?: () => string;
}

const DEFAULT_DEPS: TaskListDeps = { isConfigured, listTasks, listTaskPage, activeBackend };

function compactTask(task: ReturnType<typeof projectTaskForCaller>) {
  return { id: task.id, board: task.board, type: task.type, owner_agent: task.owner_agent,
    status: task.status, priority: task.priority, created_at: task.created_at, updated_at: task.updated_at,
    claim_ts: task.claim_ts, lease_until: task.lease_until, lease_version: task.lease_version,
    done_ts: task.done_ts, attempt_count: task.attempt_count ?? 0,
    ...('title' in task ? { title: task.title } : {}) };
}

export async function handleTaskList(
  input: TaskListInput,
  ctx: Pick<ToolContext, 'callerAgent'>,
  deps: TaskListDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  if (!deps.isConfigured()) {
    // A paged caller must not interpret an unavailable store as an exhausted traversal.
    if (input.paginate) throw new Error('task_page_unavailable');
    return {
      data: { count: 0, tasks: [], note: 'agent-state Cosmos not configured.' },
      summary: 'Ledger not configured.',
    };
  }

  const excludePersonalLegal = !canReadPersonalTasks(ctx.callerAgent);
  const { view, paginate, cursor, ...filter } = input;
  if (cursor !== undefined && !paginate) throw new Error('invalid_cursor');
  if (paginate) {
    if (view !== 'summary' || !ctx.callerAgent) throw new Error('invalid_pagination_input');
    const size = input.limit ?? 50;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('invalid_pagination_input');
    const caller = ctx.callerAgent.trim().toLowerCase();
    const board = (input.board || 'fleet').trim().toLowerCase();
    const owner = input.owner_agent ? normalizeAgent(input.owner_agent) : null;
    const status = input.status ?? null;
    const backend = (deps.activeBackend ?? activeBackend)();
    if (!caller || !board || backend !== 'postgres') throw new Error('task_page_backend_unsupported');
    const readPage = deps.listTaskPage ?? listTaskPage;
    const result = await taskPage({ caller, board, owner, status, size, backend }, cursor, {
      fetchBatch: async (after, limit) => await readPage({ board, ...(owner ? {owner} : {}),
        ...(status ? {status} : {}), ...(after ? {after} : {}), limit,
        includePersonal: canReadPersonalTasks(caller) }) as unknown as Task[],
      visibleTo: taskVisibleToCaller,
      project: (t: Task, c: string) => compactTask(projectTaskForCaller(t, c)),
    });
    return { data: { count: result.tasks.length, ...result }, summary: `${result.tasks.length} task(s); paged, not a snapshot.`, compactText: true };
  }
  const tasks = await deps.listTasks({ ...filter, exclude_personal_legal: excludePersonalLegal });
  // Defense in depth for malformed or stale store adapters. The database query performs the same
  // exclusion before its max limit, so this post-filter cannot starve an ordinary caller's page.
  const visible = tasks.filter((task) => taskVisibleToCaller(task, ctx.callerAgent));
  const projected = visible.map((task) => projectTaskForCaller(task, ctx.callerAgent));
  const rows = view === 'summary' ? projected.map(compactTask) : projected;
  return {
    data: { count: visible.length, tasks: rows },
    summary: String(visible.length) + ' task(s)' +
      (input.owner_agent ? ' for ' + input.owner_agent : '') +
      (input.status ? ' [' + input.status + ']' : '') + '.',
  };
}

export function registerTaskList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_list',
      category: 'read',
      annotations: {
        title: 'List work-ledger tasks',
        description:
          'List tasks from the fleet work-ledger, optionally filtered by owner_agent and/or status. This is the "what is everyone working on / what is open" view, live and cross-engine. Personal-legal tasks remain limited to the existing personal-legal ring. Cross-seat company views return coordination metadata only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        owner_agent: z.string().optional().describe('Filter by owning agent.'),
        status: z.enum(TASK_STATUSES).optional().describe('Filter by status.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50).'),
        view: z.enum(['full', 'summary']).optional().describe('Summary omits notes, descriptions and other details; cross-seat visibility remains unchanged. Default full.'),
        paginate: z.boolean().optional().describe('Opt into ID-ordered, non-snapshot pages on PostgreSQL; requires summary view and limit at most 100.'),
        cursor: z.string().max(2048).optional().describe('Opaque continuation returned by a prior page with identical caller, board, filters and limit.'),
      },
      outputShape: { count: z.number(), tasks: z.unknown(), next_cursor: z.string().nullable().optional(), snapshot: z.boolean().optional(), scan_incomplete: z.boolean().optional() },
      handler: handleTaskList,
    },
    callerHash,
  );
}
