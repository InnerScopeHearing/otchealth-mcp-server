import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { getTask, listEvents, type Task } from '../../agentstate/ledger.js';
import { taskVisibleToCaller } from './task-read-access.js';

export interface TaskGetInput {
  task_id: string;
  board?: string;
  include_events?: boolean;
}

export interface TaskGetDeps {
  isConfigured: () => boolean;
  getTask: (taskId: string, board?: string) => Promise<Task | null>;
  listEvents: (taskId: string) => Promise<Record<string, unknown>[]>;
}

const DEFAULT_DEPS: TaskGetDeps = { isConfigured, getTask, listEvents };

function notFound(taskId: string): ToolResultPayload {
  return { data: { found: false, task: null }, summary: 'Task ' + taskId + ' not found.' };
}

export async function handleTaskGet(
  input: TaskGetInput,
  ctx: Pick<ToolContext, 'callerAgent'>,
  deps: TaskGetDeps = DEFAULT_DEPS,
): Promise<ToolResultPayload> {
  if (!deps.isConfigured()) {
    return {
      data: { found: false, note: 'agent-state Cosmos not configured.' },
      summary: 'Ledger not configured.',
    };
  }

  const task = await deps.getTask(input.task_id, input.board);
  // An unauthorized personal task is indistinguishable from a missing task, and its event
  // partition is never touched.
  if (!task || !taskVisibleToCaller(task, ctx.callerAgent)) return notFound(input.task_id);

  const events = input.include_events === false ? [] : await deps.listEvents(input.task_id);
  return {
    data: { found: true, task, events },
    summary: 'Task ' + input.task_id + ' [' + task.status + '] owned by ' +
      task.owner_agent + ', ' + String(events.length) + ' event(s).',
  };
}

export function registerTaskGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_get',
      category: 'read',
      annotations: {
        title: 'Get a work-ledger task + its history',
        description:
          'Fetch one task by id, including its full transition history (the events log). Use to reconstruct exactly what happened to a task. Personal-legal tasks remain limited to the existing personal-legal ring.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        include_events: z.boolean().optional().describe('Include the transition history (default true).'),
      },
      outputShape: { found: z.boolean(), task: z.unknown(), events: z.unknown() },
      handler: handleTaskGet,
    },
    callerHash,
  );
}
