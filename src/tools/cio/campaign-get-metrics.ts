import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCampaignMetrics } from '../../customerio/full-client.js';

export function registerCioCampaignGetMetrics(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_campaign_get_metrics',
    category: 'read',
    annotations: {
      title: 'Get Customer.io campaign metrics',
      description: 'Fetch delivery and engagement metrics for a campaign via App API GET /campaigns/{id}/metrics. Returns sends, opens, clicks, unsubscribes, bounces, and conversion data.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      campaign_id: z.number().int().positive().describe('Numeric ID of the Customer.io campaign.'),
      period: z.enum(['hours', 'days', 'weeks', 'months']).optional().describe('Aggregation period for metrics (default: days).'),
      steps: z.number().int().min(1).max(24).optional().describe('Number of periods to return (default: varies by period).'),
      start: z.number().int().optional().describe('Start timestamp (Unix epoch) for the metrics window.'),
      end: z.number().int().optional().describe('End timestamp (Unix epoch) for the metrics window.'),
      type: z.string().optional().describe('Metric type filter (e.g. "email", "push", "sms").'),
    },
    outputShape: {
      metrics: z.unknown(),
    },
    handler: async (input, ctx) => {
      const metrics = await getCampaignMetrics({
        campaign_id: input.campaign_id,
        period: input.period,
        steps: input.steps,
        start: input.start,
        end: input.end,
        type: input.type,
        correlationId: ctx.correlationId,
      });
      return { data: { metrics } };
    },
  }, callerHash);
}
