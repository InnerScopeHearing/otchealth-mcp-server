import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { heartbeatTask } from '../../agentstate/ledger.js';

export function registerTaskHeartbeat(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_heartbeat',
      category: 'write_simple',
      annotations: {
        title: 'Extend a claimed task’s lease (dead-man’s-switch)',
        description:
          'Extend the lease on a task you currently hold, so a long-running claim is not reclaimed by another agent mid-execution. Requires you to still be the owner_agent; if expected_lease_version is passed and no longer matches, your lease was already reclaimed (fenced=true) — stop work, you may be duplicating another holder’s effort. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id whose lease to extend.'),
        agent: z.string().describe('The agent extending it (must be the current owner_agent).'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        expected_lease_version: z
          .number()
          .int()
          .optional()
          .describe('Fencing token from task_claim. If it no longer matches, the lease was reclaimed by someone else.'),
      },
      outputShape: { extended: z.boolean(), task: z.unknown(), fenced: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { extended: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        if (ctx.dryRun) return { data: { extended: false, preview: input, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would extend the lease on ${input.task_id}.` };
        const res = await heartbeatTask(input.task_id, input.agent, input.board, input.expected_lease_version);
        if (res.task) return { data: { extended: true, task: res.task }, summary: `Lease on ${input.task_id} extended to ${res.task.lease_until}.`, audit: { after: res.task } };
        return { data: { extended: false, fenced: res.fenced, reason: res.reason }, summary: `Not extended: ${res.reason}` };
      },
    },
    callerHash,
  );
}
