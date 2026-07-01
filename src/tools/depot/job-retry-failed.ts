import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { retryFailedJobs } from '../../depot/full-client.js';

export function registerDepotJobRetryFailed(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_retry_failed',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: retry all failed jobs in workflow',
      description: 'Retry only the failed and cancelled jobs in a Depot CI workflow (successful jobs are left untouched). Defaults to dry_run. CTO-only (triggers compute).',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The Depot CI workflow ID containing failed jobs.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string().optional(),
      job_ids: z.array(z.string()).optional(),
      job_count: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, workflow_id: input.workflow_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would retry all failed jobs in workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await retryFailedJobs({ workflowId: input.workflow_id });
      return {
        data: {
          executed: true,
          dry_run: false,
          workflow_id: result?.workflowId,
          job_ids: result?.jobIds ?? [],
          job_count: result?.jobCount,
        },
        audit: { before: null, after: result },
        summary: `Queued retry for ${result?.jobCount ?? 0} failed job(s) in workflow ${input.workflow_id}.`,
      };
    },
  }, callerHash);
}
