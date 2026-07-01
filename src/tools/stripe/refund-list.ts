import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRefunds } from '../../stripe/full-client.js';

export function registerStripeRefundList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_refund_list',
    category: 'read',
    annotations: {
      title: 'List Stripe refunds',
      description: 'List refunds, optionally filtered by charge or payment intent.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      charge: z.string().optional().describe('Filter by charge ID.'),
      payment_intent: z.string().optional().describe('Filter by payment intent ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      refunds: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.string(),
        charge: z.string().nullable(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listRefunds({
        limit: input.limit ?? 10,
        charge: input.charge,
        payment_intent: input.payment_intent,
        starting_after: input.starting_after,
      });
      const refunds = (result.data ?? []).map((r: any) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        charge: r.charge ?? null,
        created: new Date(r.created * 1000).toISOString(),
      }));
      return {
        data: { refunds, count: refunds.length, has_more: result.has_more ?? false },
        summary: `Found ${refunds.length} refund(s).`,
      };
    },
  }, callerHash);
}
