import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { listTasks, type Task, type TaskListFilter } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';
import { canReadPersonalTasks, taskVisibleToCaller } from './task-read-access.js';

export interface TaskListInput {
  owner_agent?: string;
  status?: TaskListFilter['status'];
  board?: string;
  limit?: number;
}

export interface TaskListDeps {
  isConfigured: () => boolean;
  listTasks: (filter: TaskListFilter) => Promise<Task[]>;
}

const DEFAULT_DEPS: TaskListDeps = { isConfigured, listTasks };

export async function handleTaskList(
  input: TaskListInput,
  ctx: Pick<ToolContext, 'callerAgent'>,
  deps: TaskListDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  if (!deps.isConfigured()) {
    return {
      data: { count: 0, tasks: [], note: 'agent-state Cosmos not configured.' },
      summary: 'Ledger not configured.',
    };
  }

  const excludePersonalLegal = !canReadPersonalTasks(ctx.callerAgent);
  const tasks = await deps.listTasks({ ...input, exclude_personal_legal: excludePersonalLegal });
  // Defense in depth for malformed or stale store adapters. The database query performs the same
  // exclusion before its max limit, so this post-filter cannot starve an ordinary caller's page.
  const visible = tasks.filter((task) => taskVisibleToCaller(task, ctx.callerAgent));
  return {
    data: { count: visible.length, tasks: visible },
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
          'List tasks from the fleet work-ledger, optionally filtered by owner_agent and/or status. This is the "what is everyone working on / what is open" view, live and cross-engine. Personal-legal tasks remain limited to the existing personal-legal ring.',
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
      },
      outputShape: { count: z.number(), tasks: z.unknown() },
      handler: handleTaskList,
    },
    callerHash,
  );
}
