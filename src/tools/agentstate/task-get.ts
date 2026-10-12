import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { getTask, listEvents, type Task } from '../../agentstate/ledger.js';
import { canReadTaskDetails, projectTaskForCaller, taskVisibleToCaller, type TaskCoordinationProjection } from './task-read-access.js';

export interface TaskGetInput {
  task_id: string;
  board?: string;
  include_events?: boolean;
  view?: 'full' | 'metadata';
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
  // The metadata response is an explicit Developer-only projection. Check the authenticated
  // identity before configuration or task lookup so unsupported callers cannot probe existence.
  if (input.view === 'metadata' && (ctx.callerAgent || '').trim().toLowerCase() !== 'developer') {
    throw new Error('Unsupported task_get view.');
  }

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

  const hasDetails = canReadTaskDetails(task, ctx.callerAgent);
  if (input.view === 'metadata') {
    const projected = projectTaskForCaller(task, ctx.callerAgent) as TaskCoordinationProjection;
    const metadata: Record<string, unknown> = {
      id: projected.id,
      board: projected.board,
      type: projected.type,
      owner_agent: projected.owner_agent,
      status: projected.status,
      priority: projected.priority,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
      claim_ts: projected.claim_ts,
      lease_until: projected.lease_until,
      lease_version: projected.lease_version,
      done_ts: projected.done_ts,
      attempt_count: projected.attempt_count,
    };
    // Detail fields stay behind the same immutable grant as full task reads. Never inspect or
    // return note bodies; TaskGetDeps currently materializes the task row, so notes_count only
    // reports the already-present array length and is not storage-level column minimization.
    if (hasDetails) {
      metadata.title = task.title;
      metadata.artifact_uri = task.artifact_uri;
      if (Array.isArray(task.notes)) metadata.notes_count = task.notes.length;
    }
    return {
      data: {
        found: true,
        task: metadata,
        events: [],
        view: 'metadata',
        details_omitted: true,
        full_fetch_required_before_action: true,
      },
      summary: 'Task ' + input.task_id + ' [' + task.status + '] metadata only; fetch the full task before acting.',
    };
  }

  const events = hasDetails && input.include_events !== false ? await deps.listEvents(input.task_id) : [];
  return {
    data: { found: true, task: projectTaskForCaller(task, ctx.callerAgent), events },
    summary: 'Task ' + input.task_id + ' [' + task.status + '] owned by ' + task.owner_agent + ', ' + String(events.length) + ' event(s).' + (hasDetails ? '' : ' Cross-seat coordination metadata only.'),
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
          'Fetch one task by id, including its full transition history by default. Pass view="metadata" for a compact Developer-only projection; it never returns event or note bodies, and you must fetch the full task before acting. Metadata does not report approvals or pending gates. Personal-legal tasks remain limited to the existing personal-legal ring. Cross-seat callers retain coordination metadata only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        include_events: z.boolean().optional().describe('Include the transition history (default true).'),
        view: z.enum(['full', 'metadata']).optional().describe('Response view (default full). Metadata is Developer-only and omits event history.'),
      },
      outputShape: { found: z.boolean(), task: z.unknown(), events: z.unknown() },
      handler: handleTaskGet,
    },
    callerHash,
  );
}
