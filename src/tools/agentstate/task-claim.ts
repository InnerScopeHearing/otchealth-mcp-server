import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { claimTask } from '../../agentstate/ledger.js';

export function registerTaskClaim(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_claim',
      category: 'write_simple',
      annotations: {
        title: 'Claim a work-ledger task (lease)',
        description:
          'Claim a task with a time-boxed lease so two engines/agents do not work the same item. Uses optimistic concurrency; a lost race returns conflict=true. Pass dry_run=false to actually claim.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id to claim.'),
        agent: z.string().describe('The agent claiming it (lowercase id).'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
      },
      outputShape: { claimed: z.boolean(), task: z.unknown(), dead_lettered: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (!isConfigured()) {
          return { data: { claimed: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        }
        if (ctx.dryRun) {
          return { data: { claimed: false, preview: input, note: 'dry_run: pass dry_run=false to claim.' }, summary: `DRY RUN: would claim ${input.task_id} for ${input.agent}.` };
        }
        const res = await claimTask(input.task_id, input.agent, input.board);
        // A14-DEAD-LETTER: check dead_lettered FIRST — claimTask returns `task` set in BOTH the
        // normal-success case and the dead-letter case, so checking `res.task` alone would wrongly
        // report a dead-lettered task as "Claimed".
        if (res.dead_lettered) {
          return {
            data: { claimed: false, task: res.task, dead_lettered: true, reason: res.reason },
            summary: `NOT claimed — ${input.task_id} exceeded its retry budget and has been dead-lettered: ${res.reason}`,
            audit: { after: res.task },
          };
        }
        if (res.task) return { data: { claimed: true, task: res.task }, summary: `Claimed ${input.task_id} for ${input.agent} (lease until ${res.task.lease_until}).`, audit: { after: res.task } };
        return { data: { claimed: false, conflict: res.conflict ?? false, reason: res.reason }, summary: `Not claimed: ${res.reason}` };
      },
    },
    callerHash,
  );
}
