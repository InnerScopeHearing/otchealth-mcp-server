import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerActivities } from '../../customerio/full-client.js';

export function registerCioCustomerGetActivities(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_get_activities',
    category: 'read',
    annotations: {
      title: 'Get activity history for a Customer.io customer',
      description: 'Fetch the full activity log for a specific customer via App API GET /customers/{id}/activities. Returns events, page views, and attribute changes with timestamps.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max activities to return (default 25).'),
      start: z.string().optional().describe('Pagination cursor from a previous response.'),
      type: z.string().optional().describe('Activity type filter (e.g. "event", "attribute", "page").'),
      name: z.string().optional().describe('Filter by activity name (e.g. specific event name).'),
      deleted: z.boolean().optional().describe('If true, include deleted customer records in the response.'),
    },
    outputShape: {
      activities: z.unknown(),
    },
    handler: async (input, ctx) => {
      const activities = await getCustomerActivities({
        customer_id: input.customer_id,
        limit: input.limit,
        start: input.start,
        type: input.type,
        name: input.name,
        deleted: input.deleted,
        correlationId: ctx.correlationId,
      });
      return { data: { activities } };
    },
  }, callerHash);
}
