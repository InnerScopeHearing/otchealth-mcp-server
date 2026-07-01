import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { updateTask } from '../../agentstate/ledger.js';
import { TASK_STATUSES } from '../../agentstate/agents.js';

export function registerTaskUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_update',
      category: 'write_simple',
      annotations: {
        title: 'Update a work-ledger task',
        description:
          'Update a task: change status (open/claimed/in_progress/blocked/cancelled), add a note, set a priority, reassign owner_agent, or attach an artifact_uri. To mark a task DONE use task_complete (which enforces done=artifact). Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id.'),
        actor: z.string().describe('Who is updating (agent id or "matt").'),
        status: z.enum(TASK_STATUSES).optional().describe('New status. Do NOT set "done" here; use task_complete.'),
        note: z.string().optional().describe('A progress note appended to the task.'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        owner_agent: z.string().optional().describe('Reassign to a different agent.'),
        artifact_uri: z.string().optional().describe('Attach an in-progress artifact pointer (not verified until task_complete).'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
      },
      outputShape: { updated: z.boolean(), task: z.unknown() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { updated: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        if (input.status === 'done') {
          return { data: { updated: false, reason: 'use task_complete for done (it enforces done=artifact).' }, summary: 'Rejected: mark done via task_complete.' };
        }
        if (ctx.dryRun) return { data: { updated: false, preview: input, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would update ${input.task_id}.` };
        const { task_id, actor, board, ...patch } = input;
        const res = await updateTask(task_id, patch, actor, board);
        if (res.task) return { data: { updated: true, task: res.task }, summary: `Updated ${task_id}.`, audit: { after: res.task } };
        return { data: { updated: false, reason: res.reason }, summary: `Not updated: ${res.reason}` };
      },
    },
    callerHash,
  );
}
