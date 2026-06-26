import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getJobSummary } from '../../depot/full-client.js';

export function registerDepotJobSummaryGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_summary_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job summary',
      description: 'Get authored step summary markdown for a Depot CI job or specific attempt. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      job_id: z.string().optional().describe('Job ID (required unless attempt_id is set).'),
      attempt_id: z.string().optional().describe('Attempt ID (required unless job_id is set).'),
    },
    outputShape: {
      summary_data: z.unknown(),
    },
    handler: async (input) => {
      const result = await getJobSummary({ jobId: input.job_id, attemptId: input.attempt_id });
      return {
        data: { summary_data: result },
        summary: result?.hasSummary
          ? `Job summary available: ${result?.stepCount ?? 0} step(s).`
          : `No summary available: ${result?.emptyReason}.`,
      };
    },
  }, callerHash);
}
