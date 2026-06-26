import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { retryJob } from '../../depot/full-client.js';

export function registerDepotJobRetry(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_retry',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: retry job',
      description: 'Retry a specific failed or cancelled Depot CI job (plus any skipped jobs that depend on it). Defaults to dry_run. CTO-only (triggers compute).',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The parent workflow ID.'),
      job_id: z.string().describe('The job ID to retry.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      job_id: z.string().optional(),
      attempt: z.number().optional(),
      status: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, job_id: input.job_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would retry job ${input.job_id} in workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await retryJob({ workflowId: input.workflow_id, jobId: input.job_id });
      return {
        data: { executed: true, dry_run: false, job_id: result?.jobId, attempt: result?.attempt, status: result?.status },
        audit: { before: null, after: result },
        summary: `Queued retry for job ${input.job_id} (attempt #${result?.attempt}).`,
      };
    },
  }, callerHash);
}
