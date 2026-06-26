import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomerPaymentMethods } from '../../stripe/full-client.js';

export function registerStripeCustomerPaymentMethodsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_customer_payment_methods_list',
    category: 'read',
    annotations: {
      title: 'List payment methods for a Stripe customer',
      description: 'List all payment methods attached to a specific customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().describe('Customer ID (cus_...).'),
      type: z.string().optional().describe('Filter by type: card, us_bank_account, etc.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
    },
    outputShape: {
      payment_methods: z.array(z.object({
        id: z.string(),
        type: z.string(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCustomerPaymentMethods(input.customer_id, {
        type: input.type,
        limit: input.limit ?? 10,
      });
      const payment_methods = (result.data ?? []).map((pm: any) => ({
        id: pm.id,
        type: pm.type,
        created: new Date(pm.created * 1000).toISOString(),
      }));
      return {
        data: { payment_methods, count: payment_methods.length, has_more: result.has_more ?? false },
        summary: `Found ${payment_methods.length} payment method(s) for customer ${input.customer_id}.`,
      };
    },
  }, callerHash);
}
