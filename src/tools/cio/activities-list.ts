import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listActivities } from '../../customerio/full-client.js';

export function registerCioActivitiesList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_activities_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io workspace activities',
      description: 'List activities across the entire Customer.io workspace via App API GET /activities. Returns events, attribute changes, and page views across all customers, with optional type/name filtering.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max activities to return (default 25).'),
      start: z.string().optional().describe('Pagination cursor from a previous response.'),
      type: z.string().optional().describe('Filter by activity type (e.g. "event", "attribute", "page").'),
      name: z.string().optional().describe('Filter by activity name (e.g. specific event name).'),
      deleted: z.boolean().optional().describe('If true, include activities from deleted customers.'),
      created_before: z.number().int().optional().describe('Return activities created before this Unix timestamp.'),
      created_after: z.number().int().optional().describe('Return activities created after this Unix timestamp.'),
    },
    outputShape: {
      activities: z.unknown(),
    },
    handler: async (input, ctx) => {
      const activities = await listActivities({ ...input, correlationId: ctx.correlationId });
      return { data: { activities } };
    },
  }, callerHash);
}
