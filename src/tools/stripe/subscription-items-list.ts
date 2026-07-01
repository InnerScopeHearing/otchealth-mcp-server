import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSubscriptionItems } from '../../stripe/full-client.js';

export function registerStripeSubscriptionItemsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_items_list',
    category: 'read',
    annotations: {
      title: 'List Stripe subscription items',
      description: 'List line items for a subscription.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      subscription_id: z.string().describe('Subscription ID (sub_...).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      items: z.array(z.unknown()),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listSubscriptionItems(input.subscription_id, {
        limit: input.limit ?? 10,
        starting_after: input.starting_after,
      });
      const items = result.data ?? [];
      return {
        data: { items, count: items.length, has_more: result.has_more ?? false },
        summary: `Found ${items.length} subscription item(s).`,
      };
    },
  }, callerHash);
}
