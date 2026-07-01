import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBroadcastMetrics } from '../../customerio/full-client.js';

export function registerCioBroadcastGetMetrics(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_broadcast_get_metrics',
    category: 'read',
    annotations: {
      title: 'Get Customer.io broadcast metrics',
      description: 'Fetch delivery and engagement metrics for a broadcast send via App API GET /newsletters/{id}/metrics. Returns sends, opens, clicks, unsubscribes, and bounce counts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      broadcast_id: z.number().int().positive().describe('Numeric ID of the broadcast/newsletter.'),
      period: z.enum(['hours', 'days', 'weeks', 'months']).optional().describe('Aggregation period (default: days).'),
      steps: z.number().int().min(1).max(24).optional().describe('Number of periods to include.'),
    },
    outputShape: {
      metrics: z.unknown(),
    },
    handler: async (input, ctx) => {
      const metrics = await getBroadcastMetrics({
        broadcast_id: input.broadcast_id,
        period: input.period,
        steps: input.steps,
        correlationId: ctx.correlationId,
      });
      return { data: { metrics } };
    },
  }, callerHash);
}
