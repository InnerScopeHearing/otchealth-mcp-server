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
  context_need?: 'coordination' | 'notes' | 'history' | 'approval' | 'correction';
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
  const contextNeed = input.context_need;
  const contextNeedView = contextNeed === undefined
    ? undefined
    : contextNeed === 'coordination' ? 'metadata' : 'full';
  if (contextNeedView !== undefined && input.view !== undefined && input.view !== contextNeedView) {
    throw new Error('Conflicting task_get view and context_need.');
  }
  if (contextNeed && (ctx.callerAgent || '').trim().toLowerCase() !== 'developer') {
    throw new Error('task_get context_need is Developer-only; omit context_need for the supported full read.');
  }
  // Resolve the controller-known question class before returning anything to a model. Questions
  // limited to coordination facts use the compact view; note, history, approval, and correction
  // questions receive the existing full response. This routing does not infer gates from metadata.
  const responseView = contextNeedView ?? input.view ?? 'full';
  const needsHistory = contextNeed === 'history' || contextNeed === 'approval' || contextNeed === 'correction';

  // Metadata is an explicit Developer-only response view. Reject unsupported callers before
  // configuration or task lookup so this option cannot be used to probe task existence.
  if (responseView === 'metadata' && (ctx.callerAgent || '').trim().toLowerCase() !== 'developer') {
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
  if (responseView === 'metadata') {
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
      // Legacy task documents may predate this field; match the established coordination projection.
      attempt_count: projected.attempt_count ?? 0,
    };
    // Detail fields use the existing immutable grant. This handler receives a materialized task,
    // so omitting these fields limits response context, not storage reads. Never return note bodies.
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

  const events = hasDetails && (needsHistory || input.include_events !== false) ? await deps.listEvents(input.task_id) : [];
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
          'Fetch one task by id. For controller-known needs, context_need="coordination" selects compact metadata; context_need="notes", "history", "approval", or "correction" selects full detail before model interpretation. Approval and correction questions must use full task/event evidence; metadata does not report approvals or pending gates. The default remains the full response. Pass view="metadata" only for an explicit compact Developer-only projection. Personal-legal tasks remain limited to the existing personal-legal ring. Cross-seat callers retain coordination metadata only.',
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
        context_need: z.enum(['coordination', 'notes', 'history', 'approval', 'correction']).optional().describe('Developer controller route: only coordination uses metadata; notes/history/approval/correction fetch full detail before model interpretation.'),
      },
      outputShape: { found: z.boolean(), task: z.unknown(), events: z.unknown() },
      handler: handleTaskGet,
    },
    callerHash,
  );
}
