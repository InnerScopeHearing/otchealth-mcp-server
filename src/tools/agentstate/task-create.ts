import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { createTask } from '../../agentstate/ledger.js';
import { resolveAttribution } from './attribution.js';

/**
 * ATTRIBUTION (FND-20260829-878f, see attribution.ts's module doc comment for the full triage):
 * `created_by` is now bound to the caller's authenticated token identity (ctx.callerAgent), not
 * trusted verbatim from input -- a caller-supplied value that disagrees is recorded as
 * `claimed_actor` for audit instead of being written as the ledger's truth. `owner_agent` (who the
 * task is ASSIGNED to) is a deliberate, unrelated exception: dispatching work to a different named
 * agent is this tool's whole purpose, so it stays exactly as the caller specifies it.
 */
export interface TaskCreateInput {
  title: string;
  owner_agent: string;
  created_by: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  tags?: string[];
  board?: string;
  idempotency_key?: string;
}

/** Exported standalone (mirroring memory-write.ts's handleMemoryWrite) so the attribution binding
 *  is directly testable through the actual registered entry point, not only through
 *  resolveAttribution's own pure-function tests. */
export async function handleTaskCreate(input: TaskCreateInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (!isConfigured()) {
    return { data: { created: false, task: null, note: 'agent-state Cosmos not configured on the gateway.' }, summary: 'Ledger not configured; nothing written.' };
  }
  const { actor, claimed_actor } = resolveAttribution(ctx.callerAgent, input.created_by);
  if (ctx.dryRun) {
    return {
      data: {
        created: false,
        preview: { ...input, created_by: actor },
        claimed_actor,
        note: 'dry_run: not written. Pass dry_run=false to persist.',
      },
      summary: `DRY RUN: would create task "${input.title}" for ${input.owner_agent} (created_by=${actor}).`,
    };
  }
  const { task, deduped } = await createTask({ ...input, created_by: actor, claimed_created_by: claimed_actor });
  return {
    data: { created: !deduped, task, deduped, claimed_actor },
    summary: deduped
      ? `Idempotent create: task ${task.id} already existed for this idempotency_key -- returned the original, nothing duplicated.`
      : `Created task ${task.id} for ${task.owner_agent} (status open).`,
    audit: { after: task },
  };
}

export function registerTaskCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_create',
      category: 'write_simple',
      annotations: {
        title: 'Create a work-ledger task',
        description:
          'Create a task in the fleet work-ledger (the single system-of-record). Assign it to a named agent (owner_agent). This is how work is dispatched cross-engine: any engine reads/writes the same ledger through the gateway. created_by is recorded as YOUR authenticated identity; a caller-supplied created_by that names someone else is preserved as claimed_actor for audit, never trusted as the record of who actually called this (FND-20260829-878f). Pass dry_run=false to actually write. Non-PHI, non-MNPI, non-privileged only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        title: z.string().min(1).describe('Short imperative task title.'),
        owner_agent: z.string().describe('Agent that owns the task (lowercase id, e.g. "cto", "developer", "cfo").'),
        created_by: z
          .string()
          .describe(
            'Who is creating it (agent id or "matt"). Recorded attribution is always YOUR authenticated identity; if this disagrees, your input is kept as claimed_actor for audit only.',
          ),
        description: z.string().optional().describe('Optional detail / acceptance criteria.'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Default normal.'),
        tags: z.array(z.string()).optional().describe('Optional tags for filtering.'),
        board: z.string().optional().describe('Optional board partition (default "fleet").'),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            'Optional caller-chosen key (e.g. a dispatch/request id). Retrying task_create with the SAME key on the same board returns the ORIGINAL task instead of creating a duplicate -- use this whenever a create might be retried (timeouts, at-least-once dispatch).',
          ),
      },
      outputShape: {
        created: z.boolean(),
        task: z.unknown(),
        deduped: z.boolean().optional(),
        claimed_actor: z.string().optional(),
      },
      handler: handleTaskCreate,
    },
    callerHash,
  );
}
