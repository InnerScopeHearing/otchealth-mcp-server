import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getJobAttemptMetrics } from '../../depot/full-client.js';

export function registerDepotAttemptMetricsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_attempt_metrics_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get job attempt metrics',
      description: 'Get CPU and memory metrics for a specific Depot CI job attempt. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      attempt_id: z.string().describe('The Depot CI attempt ID.'),
    },
    outputShape: {
      metrics: z.unknown(),
    },
    handler: async (input) => {
      const result = await getJobAttemptMetrics({ attemptId: input.attempt_id });
      return {
        data: { metrics: result },
        summary: `Metrics for attempt ${input.attempt_id} fetched.`,
      };
    },
  }, callerHash);
}
