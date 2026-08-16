import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { listTasks } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';

export function registerTaskList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_list',
      category: 'read',
      annotations: {
        title: 'List work-ledger tasks',
        description:
          'List tasks from the fleet work-ledger, optionally filtered by owner_agent and/or status. This is the "what is everyone working on / what is open" view, live and cross-engine.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        owner_agent: z.string().optional().describe('Filter by owning agent.'),
        status: z.enum(TASK_STATUSES).optional().describe('Filter by status.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50).'),
      },
      outputShape: { count: z.number(), tasks: z.unknown() },
      handler: async (input) => {
        if (!isConfigured()) return { data: { count: 0, tasks: [], note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        const tasks = await listTasks(input);
        return { data: { count: tasks.length, tasks }, summary: `${tasks.length} task(s)${input.owner_agent ? ` for ${input.owner_agent}` : ''}${input.status ? ` [${input.status}]` : ''}.` };
      },
    },
    callerHash,
  );
}
