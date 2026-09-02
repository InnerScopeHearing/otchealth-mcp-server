import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { claimTask } from '../../agentstate/ledger.js';
import { resolveAttribution } from './attribution.js';

/**
 * ATTRIBUTION (FND-20260829-878f, see attribution.ts's module doc comment for the full triage):
 * unlike task_create's owner_agent, `agent` here is inherently self-referential -- claiming a lease
 * is "I, the caller, am about to do this," never "claim this on behalf of someone else" (that is a
 * reassignment, task_update's job). So the value actually written as the lease holder
 * (task.owner_agent) is now bound to the caller's authenticated token identity; a caller-supplied
 * `agent` that names someone else is refused as the lease holder and instead recorded as
 * `claimed_actor` for audit. This closes a real capability gap, not only a cosmetic one: previously
 * any caller could park a claim/lease under ANY named identity.
 */
export interface TaskClaimInput {
  task_id: string;
  agent: string;
  board?: string;
}

/** Exported standalone (mirroring memory-write.ts's handleMemoryWrite) so the attribution binding
 *  is directly testable through the actual registered entry point. */
export async function handleTaskClaim(input: TaskClaimInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (!isConfigured()) {
    return { data: { claimed: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
  }
  const { actor, claimed_actor } = resolveAttribution(ctx.callerAgent, input.agent);
  if (ctx.dryRun) {
    return {
      data: { claimed: false, preview: { ...input, agent: actor }, claimed_actor, note: 'dry_run: pass dry_run=false to claim.' },
      summary: `DRY RUN: would claim ${input.task_id} for ${actor}.`,
    };
  }
  const res = await claimTask(input.task_id, actor, input.board, claimed_actor);
  // A14-DEAD-LETTER: check dead_lettered FIRST -- claimTask returns `task` set in BOTH the
  // normal-success case and the dead-letter case, so checking `res.task` alone would wrongly
  // report a dead-lettered task as "Claimed".
  if (res.dead_lettered) {
    return {
      data: { claimed: false, task: res.task, dead_lettered: true, reason: res.reason, claimed_actor },
      summary: `NOT claimed -- ${input.task_id} exceeded its retry budget and has been dead-lettered: ${res.reason}`,
      audit: { after: res.task },
    };
  }
  if (res.task) {
    return {
      data: { claimed: true, task: res.task, claimed_actor },
      summary: `Claimed ${input.task_id} for ${actor} (lease until ${res.task.lease_until}).`,
      audit: { after: res.task },
    };
  }
  return { data: { claimed: false, conflict: res.conflict ?? false, reason: res.reason }, summary: `Not claimed: ${res.reason}` };
}

export function registerTaskClaim(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_claim',
      category: 'write_simple',
      annotations: {
        title: 'Claim a work-ledger task (lease)',
        description:
          'Claim a task with a time-boxed lease so two engines/agents do not work the same item. Uses optimistic concurrency; a lost race returns conflict=true. The lease is always recorded under YOUR authenticated identity; a caller-supplied agent that names someone else is refused as the lease holder and kept only as claimed_actor for audit (FND-20260829-878f). Pass dry_run=false to actually claim.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id to claim.'),
        agent: z
          .string()
          .describe(
            'The agent claiming it (lowercase id). The lease is always recorded under your authenticated identity; if this disagrees, your input is kept as claimed_actor for audit only.',
          ),
        board: z.string().optional().describe('Board partition (default "fleet").'),
      },
      outputShape: {
        claimed: z.boolean(),
        task: z.unknown(),
        dead_lettered: z.boolean().optional(),
        claimed_actor: z.string().optional(),
      },
      handler: handleTaskClaim,
    },
    callerHash,
  );
}
