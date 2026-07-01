import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelJob } from '../../depot/full-client.js';

export function registerDepotJobCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: cancel job',
      description: 'Cancel a queued, waiting, or running Depot CI job and its active attempt. Defaults to dry_run. CTO-only (terminates compute).',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The parent workflow ID.'),
      job_id: z.string().describe('The job ID to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      job_id: z.string().optional(),
      status: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, job_id: input.job_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel job ${input.job_id} in workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await cancelJob({ workflowId: input.workflow_id, jobId: input.job_id });
      return {
        data: { executed: true, dry_run: false, job_id: result?.jobId, status: result?.status },
        audit: { before: null, after: result },
        summary: `Cancelled job ${input.job_id}. Status: ${result?.status}.`,
      };
    },
  }, callerHash);
}
