import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { heartbeatTask } from '../../agentstate/ledger.js';
import { resolveAttribution } from './attribution.js';

/**
 * ATTRIBUTION (FND-20260829-878f, see attribution.ts's module doc comment for the full triage):
 * heartbeatTask's `agent` param is a REAL authorization check, not only a label -- ledger.ts rejects
 * a heartbeat unless `agent` equals the task's current owner_agent. Binding it to the caller's
 * authenticated token identity means only the genuine lease holder (by real token identity, not by
 * whatever string they pass) can extend their own lease; a caller-supplied `agent` that names
 * someone else is recorded as `claimed_actor` for audit rather than substituted into the check.
 */
export interface TaskHeartbeatInput {
  task_id: string;
  agent: string;
  board?: string;
  expected_lease_version?: number;
}

/** Exported standalone (mirroring memory-write.ts's handleMemoryWrite) so the attribution binding
 *  is directly testable through the actual registered entry point. */
export async function handleTaskHeartbeat(input: TaskHeartbeatInput, ctx: ToolContext): Promise<ToolResultPayload> {
  if (!isConfigured()) return { data: { extended: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
  const { actor, claimed_actor } = resolveAttribution(ctx.callerAgent, input.agent);
  if (ctx.dryRun) {
    return {
      data: { extended: false, preview: { ...input, agent: actor }, claimed_actor, note: 'dry_run: pass dry_run=false to persist.' },
      summary: `DRY RUN: would extend the lease on ${input.task_id}.`,
    };
  }
  const res = await heartbeatTask(input.task_id, actor, input.board, input.expected_lease_version, claimed_actor);
  if (res.task) {
    return {
      data: { extended: true, task: res.task, claimed_actor },
      summary: `Lease on ${input.task_id} extended to ${res.task.lease_until}.`,
      audit: { after: res.task },
    };
  }
  return { data: { extended: false, fenced: res.fenced, reason: res.reason }, summary: `Not extended: ${res.reason}` };
}

export function registerTaskHeartbeat(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_heartbeat',
      category: 'write_simple',
      annotations: {
        title: 'Extend a claimed task’s lease (dead-man’s-switch)',
        description:
          'Extend the lease on a task you currently hold, so a long-running claim is not reclaimed by another agent mid-execution. Requires YOUR authenticated identity to still be the owner_agent (a caller-supplied agent that names someone else is refused as the holder and kept only as claimed_actor for audit, FND-20260829-878f); if expected_lease_version is passed and no longer matches, your lease was already reclaimed (fenced=true) -- stop work, you may be duplicating another holder’s effort. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id whose lease to extend.'),
        agent: z
          .string()
          .describe(
            'The agent extending it (must be the current owner_agent). Checked against YOUR authenticated identity; if this disagrees, your input is kept as claimed_actor for audit only.',
          ),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        expected_lease_version: z
          .number()
          .int()
          .optional()
          .describe('Fencing token from task_claim. If it no longer matches, the lease was reclaimed by someone else.'),
      },
      outputShape: {
        extended: z.boolean(),
        task: z.unknown(),
        fenced: z.boolean().optional(),
        claimed_actor: z.string().optional(),
      },
      handler: handleTaskHeartbeat,
    },
    callerHash,
  );
}
