import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { completeTask } from '../../agentstate/ledger.js';
import { resolveAttribution } from './attribution.js';

/**
 * ATTRIBUTION (FND-20260829-878f, see attribution.ts's module doc comment for the full triage):
 * `agent` (who completed it) is now bound to the caller's authenticated token identity, not trusted
 * verbatim from input -- a caller-supplied value that disagrees is recorded as `claimed_actor` for
 * audit instead of being written as the completion record's truth.
 */
export interface TaskCompleteInput {
  task_id: string;
  artifact_uri: string;
  agent: string;
  note?: string;
  board?: string;
  expected_lease_version?: number;
}

/** Exported standalone (mirroring memory-write.ts's handleMemoryWrite) so the attribution binding
 *  is directly testable through the actual registered entry point. */
export async function handleTaskComplete(input: TaskCompleteInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (!isConfigured()) return { data: { completed: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
  const { actor, claimed_actor } = resolveAttribution(ctx.callerAgent, input.agent);
  if (ctx.dryRun) {
    return {
      data: { completed: false, preview: { ...input, agent: actor }, claimed_actor, note: 'dry_run: pass dry_run=false to complete.' },
      summary: `DRY RUN: would complete ${input.task_id} with ${input.artifact_uri}.`,
    };
  }
  const res = await completeTask(input.task_id, input.artifact_uri, actor, input.note, input.board, input.expected_lease_version, claimed_actor);
  if (res.task) {
    return {
      data: { completed: true, task: res.task, resolution: res.resolution, claimed_actor },
      summary: `Completed ${input.task_id}. Artifact verified: ${input.artifact_uri}.`,
      audit: { after: res.task },
    };
  }
  return {
    data: { completed: false, rejected: res.rejected ?? false, fenced: res.fenced, reason: res.reason, resolution: res.resolution },
    summary: res.rejected ? `REJECTED (done=artifact): ${res.reason}` : `Not completed: ${res.reason}`,
  };
}

export function registerTaskComplete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_complete',
      category: 'write_simple',
      annotations: {
        title: 'Complete a task (done = artifact landed)',
        description:
          'Mark a task DONE. This REJECTS unless artifact_uri resolves to a real, durable artifact: blob:<path> (commons), cosmos:<coll>/<pk>/<id>, https://... (HEAD < 400), or gh:commit:owner/repo@sha / gh:pr:owner/repo#n. "Analysis done but nothing committed" and "done = a branch/chat" are structurally rejected. The completion is always attributed to YOUR authenticated identity; a caller-supplied agent that names someone else is preserved as claimed_actor for audit, never trusted as the record of who actually called this (FND-20260829-878f). Land the work-product first, then complete. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id to complete.'),
        artifact_uri: z.string().describe('Pointer to the landed work-product (blob:/cosmos:/https:/gh:).'),
        agent: z
          .string()
          .describe(
            'The agent completing it. Recorded attribution is always YOUR authenticated identity; if this disagrees, your input is kept as claimed_actor for audit only.',
          ),
        note: z.string().optional().describe('Optional completion note.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        expected_lease_version: z
          .number()
          .int()
          .optional()
          .describe(
            'Fencing token from task_claim. If passed and the task has since been reclaimed by someone else, completion is REJECTED instead of a zombie holder marking done over the new holder’s in-progress work.',
          ),
      },
      outputShape: {
        completed: z.boolean(),
        task: z.unknown(),
        resolution: z.unknown(),
        fenced: z.boolean().optional(),
        claimed_actor: z.string().optional(),
      },
      handler: handleTaskComplete,
    },
    callerHash,
  );
}
