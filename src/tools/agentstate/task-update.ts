import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { updateTask } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';
import { resolveAttribution } from './attribution.js';

/**
 * ATTRIBUTION (FND-20260829-878f, see attribution.ts's module doc comment for the full triage):
 * `actor` (who is updating) is now bound to the caller's authenticated token identity, not trusted
 * verbatim from input -- a caller-supplied value that disagrees is recorded as `claimed_actor` for
 * audit instead of being written as the event log's truth. `owner_agent` (reassignment TARGET) is a
 * deliberate, unrelated exception: reassigning a task to a different named agent is exactly what
 * this field is for, so it stays exactly as the caller specifies it.
 */
export interface TaskUpdateInput {
  task_id: string;
  actor: string;
  status?: (typeof TASK_STATUSES)[number];
  note?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  owner_agent?: string;
  artifact_uri?: string;
  board?: string;
  expected_lease_version?: number;
}

/** Exported standalone (mirroring memory-write.ts's handleMemoryWrite) so the attribution binding
 *  is directly testable through the actual registered entry point. */
export async function handleTaskUpdate(input: TaskUpdateInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (!isConfigured()) return { data: { updated: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
  if (input.status === 'done') {
    return { data: { updated: false, reason: 'use task_complete for done (it enforces done=artifact).' }, summary: 'Rejected: mark done via task_complete.' };
  }
  const { actor, claimed_actor } = resolveAttribution(ctx.callerAgent, input.actor);
  if (ctx.dryRun) {
    return {
      data: { updated: false, preview: { ...input, actor }, claimed_actor, note: 'dry_run: pass dry_run=false to persist.' },
      summary: `DRY RUN: would update ${input.task_id}.`,
    };
  }
  const patch = {
    status: input.status,
    note: input.note,
    priority: input.priority,
    owner_agent: input.owner_agent,
    artifact_uri: input.artifact_uri,
  };
  const res = await updateTask(input.task_id, patch, actor, input.board, input.expected_lease_version, claimed_actor);
  if (res.task) return { data: { updated: true, task: res.task, claimed_actor }, summary: `Updated ${input.task_id}.`, audit: { after: res.task } };
  return { data: { updated: false, fenced: res.fenced, reason: res.reason }, summary: `Not updated: ${res.reason}` };
}

export function registerTaskUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_update',
      category: 'write_simple',
      annotations: {
        title: 'Update a work-ledger task',
        description:
          'Update a task: change status (open/claimed/in_progress/blocked/cancelled), add a note, set a priority, reassign owner_agent, or attach an artifact_uri. To mark a task DONE use task_complete (which enforces done=artifact). The update is always attributed to YOUR authenticated identity; a caller-supplied actor that names someone else is preserved as claimed_actor for audit, never trusted as the record of who actually called this (FND-20260829-878f). Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id.'),
        actor: z
          .string()
          .describe(
            'Who is updating (agent id or "matt"). Recorded attribution is always YOUR authenticated identity; if this disagrees, your input is kept as claimed_actor for audit only.',
          ),
        status: z.enum(TASK_STATUSES).optional().describe('New status. Do NOT set "done" here; use task_complete.'),
        note: z.string().optional().describe('A progress note appended to the task.'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        owner_agent: z.string().optional().describe('Reassign to a different agent.'),
        artifact_uri: z.string().optional().describe('Attach an in-progress artifact pointer (not verified until task_complete).'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        expected_lease_version: z
          .number()
          .int()
          .optional()
          .describe(
            'Fencing token from task_claim. If passed and the task has since been reclaimed by someone else (lease_version changed), the update is REJECTED instead of silently clobbering the new holder’s work.',
          ),
      },
      outputShape: { updated: z.boolean(), task: z.unknown(), fenced: z.boolean().optional(), claimed_actor: z.string().optional() },
      handler: handleTaskUpdate,
    },
    callerHash,
  );
}
