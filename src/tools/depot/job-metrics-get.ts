import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getJobMetrics } from '../../depot/full-client.js';

export function registerDepotJobMetricsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_job_metrics_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job metrics',
      description: 'Get per-attempt CPU and memory metric summaries for a Depot CI job. Useful for diagnosing resource-intensive jobs. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      job_id: z.string().describe('The Depot CI job ID.'),
    },
    outputShape: {
      metrics: z.unknown(),
    },
    handler: async (input) => {
      const result = await getJobMetrics({ jobId: input.job_id });
      return {
        data: { metrics: result },
        summary: `Job metrics for ${input.job_id} fetched. ${result?.attempts?.length ?? 0} attempt(s).`,
      };
    },
  }, callerHash);
}
