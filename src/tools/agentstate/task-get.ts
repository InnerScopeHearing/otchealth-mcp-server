import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { getTask, listEvents } from '../../agentstate/ledger.js';

export function registerTaskGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_get',
      category: 'read',
      annotations: {
        title: 'Get a work-ledger task + its history',
        description: 'Fetch one task by id, including its full transition history (the events log). Use to reconstruct exactly what happened to a task.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
        include_events: z.boolean().optional().describe('Include the transition history (default true).'),
      },
      outputShape: { found: z.boolean(), task: z.unknown(), events: z.unknown() },
      handler: async (input) => {
        if (!isConfigured()) return { data: { found: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        const task = await getTask(input.task_id, input.board);
        if (!task) return { data: { found: false, task: null }, summary: `Task ${input.task_id} not found.` };
        const events = input.include_events === false ? [] : await listEvents(input.task_id);
        return { data: { found: true, task, events }, summary: `Task ${input.task_id} [${task.status}] owned by ${task.owner_agent}, ${events.length} event(s).` };
      },
    },
    callerHash,
  );
}
