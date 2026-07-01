import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { completeTask } from '../../agentstate/ledger.js';

export function registerTaskComplete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'task_complete',
      category: 'write_simple',
      annotations: {
        title: 'Complete a task (done = artifact landed)',
        description:
          'Mark a task DONE. This REJECTS unless artifact_uri resolves to a real, durable artifact: blob:<path> (commons), cosmos:<coll>/<pk>/<id>, https://... (HEAD < 400), or gh:commit:owner/repo@sha / gh:pr:owner/repo#n. "Analysis done but nothing committed" and "done = a branch/chat" are structurally rejected. Land the work-product first, then complete. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        task_id: z.string().describe('The task id to complete.'),
        artifact_uri: z.string().describe('Pointer to the landed work-product (blob:/cosmos:/https:/gh:).'),
        agent: z.string().describe('The agent completing it.'),
        note: z.string().optional().describe('Optional completion note.'),
        board: z.string().optional().describe('Board partition (default "fleet").'),
      },
      outputShape: { completed: z.boolean(), task: z.unknown(), resolution: z.unknown() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { completed: false, note: 'agent-state Cosmos not configured.' }, summary: 'Ledger not configured.' };
        if (ctx.dryRun) return { data: { completed: false, preview: input, note: 'dry_run: pass dry_run=false to complete.' }, summary: `DRY RUN: would complete ${input.task_id} with ${input.artifact_uri}.` };
        const res = await completeTask(input.task_id, input.artifact_uri, input.agent, input.note, input.board);
        if (res.task) {
          return { data: { completed: true, task: res.task, resolution: res.resolution }, summary: `Completed ${input.task_id}. Artifact verified: ${input.artifact_uri}.`, audit: { after: res.task } };
        }
        return {
          data: { completed: false, rejected: res.rejected ?? false, reason: res.reason, resolution: res.resolution },
          summary: res.rejected ? `REJECTED (done=artifact): ${res.reason}` : `Not completed: ${res.reason}`,
        };
      },
    },
    callerHash,
  );
}
