import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPaymentMethods } from '../../stripe/full-client.js';

export function registerStripePaymentMethodList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_method_list',
    category: 'read',
    annotations: {
      title: 'List Stripe payment methods',
      description: 'List payment methods, optionally for a specific customer or type.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      customer: z.string().optional().describe('Filter by customer ID.'),
      type: z.string().optional().describe('Filter by type: card, us_bank_account, sepa_debit, etc.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      payment_methods: z.array(z.object({
        id: z.string(),
        type: z.string(),
        customer: z.string().nullable(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listPaymentMethods({
        customer: input.customer,
        type: input.type,
        limit: input.limit ?? 10,
        starting_after: input.starting_after,
      });
      const payment_methods = (result.data ?? []).map((pm: any) => ({
        id: pm.id,
        type: pm.type,
        customer: pm.customer ?? null,
        created: new Date(pm.created * 1000).toISOString(),
      }));
      return {
        data: { payment_methods, count: payment_methods.length, has_more: result.has_more ?? false },
        summary: `Found ${payment_methods.length} payment method(s).`,
      };
    },
  }, callerHash);
}
