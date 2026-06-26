import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSubscriptions } from '../../stripe/full-client.js';

export function registerStripeSubscriptionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_list',
    category: 'read',
    annotations: {
      title: 'List Stripe subscriptions',
      description: 'List subscriptions, optionally filtered by customer, status, or price.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      status: z.string().optional().describe('Filter by status: active, past_due, canceled, trialing, etc.'),
      price: z.string().optional().describe('Filter by price ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination (last object ID from previous page).'),
    },
    outputShape: {
      subscriptions: z.array(z.object({
        id: z.string(),
        status: z.string(),
        customer: z.string(),
        current_period_end: z.string().nullable(),
        cancel_at_period_end: z.boolean(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listSubscriptions({
        limit: input.limit ?? 10,
        customer: input.customer,
        status: input.status,
        price: input.price,
        starting_after: input.starting_after,
      });
      const subscriptions = (result.data ?? []).map((s: any) => ({
        id: s.id,
        status: s.status,
        customer: s.customer,
        current_period_end: s.current_period_end
          ? new Date(s.current_period_end * 1000).toISOString()
          : null,
        cancel_at_period_end: s.cancel_at_period_end ?? false,
      }));
      return {
        data: { subscriptions, count: subscriptions.length, has_more: result.has_more ?? false },
        summary: `Found ${subscriptions.length} subscription(s).`,
      };
    },
  }, callerHash);
}
