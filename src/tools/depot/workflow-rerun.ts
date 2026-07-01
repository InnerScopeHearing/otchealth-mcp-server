import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { rerunWorkflow } from '../../depot/full-client.js';

export function registerDepotWorkflowRerun(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_workflow_rerun',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: rerun workflow',
      description: 'Rerun all jobs in a Depot CI workflow that are in a terminal state. Cancel the workflow first if still running. Defaults to dry_run. CTO-only (triggers compute).',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The Depot CI workflow ID to rerun.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string().optional(),
      job_count: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, workflow_id: input.workflow_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would rerun all jobs in workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await rerunWorkflow({ workflowId: input.workflow_id });
      return {
        data: { executed: true, dry_run: false, workflow_id: result?.workflowId, job_count: result?.jobCount },
        audit: { before: null, after: result },
        summary: `Rerunning workflow ${input.workflow_id}: ${result?.jobCount ?? 0} job(s) reset to queued.`,
      };
    },
  }, callerHash);
}
