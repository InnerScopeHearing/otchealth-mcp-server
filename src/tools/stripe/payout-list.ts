import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPayouts } from '../../stripe/full-client.js';

export function registerStripePayoutList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payout_list',
    category: 'read',
    annotations: {
      title: 'List Stripe payouts',
      description: 'List payouts to the connected bank account.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      status: z.enum(['paid', 'pending', 'in_transit', 'canceled', 'failed']).optional().describe('Filter by status.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
      arrival_date_gte: z.number().int().optional().describe('Filter: arrival date >= (Unix timestamp).'),
      arrival_date_lte: z.number().int().optional().describe('Filter: arrival date <= (Unix timestamp).'),
    },
    outputShape: {
      payouts: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.string(),
        arrival_date: z.string().nullable(),
        method: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listPayouts({
        limit: input.limit ?? 10,
        status: input.status,
        starting_after: input.starting_after,
        arrival_date_gte: input.arrival_date_gte,
        arrival_date_lte: input.arrival_date_lte,
      });
      const payouts = (result.data ?? []).map((p: any) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        method: p.method,
      }));
      return {
        data: { payouts, count: payouts.length, has_more: result.has_more ?? false },
        summary: `Found ${payouts.length} payout(s).`,
      };
    },
  }, callerHash);
}
