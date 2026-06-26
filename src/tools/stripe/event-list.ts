import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEvents } from '../../stripe/full-client.js';

export function registerStripeEventList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_event_list',
    category: 'read',
    annotations: {
      title: 'List Stripe events',
      description: 'List Stripe events (webhook log). Filter by type and date range.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      type: z.string().optional().describe('Filter by event type (e.g. invoice.paid, customer.created).'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
      created_gte: z.number().int().optional().describe('Created >= (Unix timestamp).'),
      created_lte: z.number().int().optional().describe('Created <= (Unix timestamp).'),
    },
    outputShape: {
      events: z.array(z.object({
        id: z.string(),
        type: z.string(),
        created: z.string(),
        livemode: z.boolean(),
        request_id: z.string().nullable(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listEvents({
        limit: input.limit ?? 10,
        type: input.type,
        starting_after: input.starting_after,
        created_gte: input.created_gte,
        created_lte: input.created_lte,
      });
      const events = (result.data ?? []).map((e: any) => ({
        id: e.id,
        type: e.type,
        created: new Date(e.created * 1000).toISOString(),
        livemode: e.livemode,
        request_id: e.request?.id ?? null,
      }));
      return {
        data: { events, count: events.length, has_more: result.has_more ?? false },
        summary: `Found ${events.length} event(s).`,
      };
    },
  }, callerHash);
}
