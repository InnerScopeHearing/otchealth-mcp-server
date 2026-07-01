import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRunMetrics } from '../../depot/full-client.js';

export function registerDepotRunMetricsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_run_metrics_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get run metrics',
      description: 'Get CPU and memory metric summaries for all jobs and attempts in a Depot CI run. Useful for performance diagnosis and cost attribution. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      run_id: z.string().describe('The Depot CI run ID.'),
    },
    outputShape: {
      metrics: z.unknown(),
    },
    handler: async (input) => {
      const result = await getRunMetrics({ runId: input.run_id });
      return {
        data: { metrics: result },
        summary: `Metrics for run ${input.run_id} fetched.`,
      };
    },
  }, callerHash);
}
