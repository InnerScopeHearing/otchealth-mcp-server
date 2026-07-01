import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { createTask } from '../../agentstate/ledger.js';

export function registerTaskCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_create',
      category: 'write_simple',
      annotations: {
        title: 'Create a work-ledger task',
        description:
          'Create a task in the fleet work-ledger (Cosmos, the single system-of-record). Assign it to a named agent (owner_agent). This is how work is dispatched cross-engine: any engine reads/writes the same ledger through the gateway. Pass dry_run=false to actually write. Non-PHI, non-MNPI, non-privileged only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        title: z.string().min(1).describe('Short imperative task title.'),
        owner_agent: z.string().describe('Agent that owns the task (lowercase id, e.g. "cto", "developer", "cfo").'),
        created_by: z.string().describe('Who is creating it (agent id or "matt").'),
        description: z.string().optional().describe('Optional detail / acceptance criteria.'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('Default normal.'),
        tags: z.array(z.string()).optional().describe('Optional tags for filtering.'),
        board: z.string().optional().describe('Optional board partition (default "fleet").'),
      },
      outputShape: { created: z.boolean(), task: z.unknown() },
      handler: async (input, ctx) => {
        if (!isConfigured()) {
          return { data: { created: false, task: null, note: 'agent-state Cosmos not configured on the gateway.' }, summary: 'Ledger not configured; nothing written.' };
        }
        if (ctx.dryRun) {
          return {
            data: { created: false, preview: input, note: 'dry_run: not written. Pass dry_run=false to persist.' },
            summary: `DRY RUN: would create task "${input.title}" for ${input.owner_agent}.`,
          };
        }
        const task = await createTask(input);
        return { data: { created: true, task }, summary: `Created task ${task.id} for ${task.owner_agent} (status open).`, audit: { after: task } };
      },
    },
    callerHash,
  );
}
