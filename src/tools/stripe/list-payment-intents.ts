import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPaymentIntents } from '../../stripe/api-client.js';

export function registerStripeListPaymentIntents(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_list_payment_intents',
    category: 'read',
    annotations: {
      title: 'List Stripe payment intents',
      description: 'List payment intents. Amounts in dollars.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
    },
    outputShape: {
      payment_intents: z.array(z.object({ id: z.string(), amount: z.number(), currency: z.string(), status: z.string(), created: z.string() })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listPaymentIntents({ limit: input.limit ?? 10, customer: input.customer });
      const pis = (result.data ?? []).map((p: any) => ({
        id: p.id, amount: p.amount / 100, currency: p.currency, status: p.status,
        created: new Date(p.created * 1000).toISOString(),
      }));
      return {
        data: { payment_intents: pis, count: pis.length, has_more: result.has_more ?? false },
        summary: `Found ${pis.length} payment intent(s).`,
      };
    },
  }, callerHash);
}
