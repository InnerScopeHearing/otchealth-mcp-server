import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSubscription } from '../../stripe/full-client.js';

export function registerStripeSubscriptionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update Stripe subscription',
      description: 'Update an existing subscription (items, coupon, payment method, etc.). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      subscription_id: z.string().describe('Subscription ID (sub_...).'),
      cancel_at_period_end: z.boolean().optional().describe('Schedule cancellation at period end.'),
      proration_behavior: z.enum(['create_prorations', 'none', 'always_invoice']).optional(),
      items: z.array(z.object({
        id: z.string().optional().describe('Existing subscription item ID to modify.'),
        price: z.string().optional().describe('New price ID.'),
        quantity: z.number().int().min(0).optional().describe('New quantity.'),
        deleted: z.boolean().optional().describe('Set true to remove this item.'),
      })).optional(),
      coupon: z.string().optional().describe('Coupon ID to apply.'),
      promotion_code: z.string().optional().describe('Promotion code ID to apply.'),
      default_payment_method: z.string().optional().describe('Default payment method ID.'),
      description: z.string().optional().describe('Description.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      subscription_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, subscription_id: input.subscription_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update subscription ${input.subscription_id}. Pass dry_run=false to apply.`,
        };
      }
      const { subscription_id, ...params } = input;
      const upstream = await updateSubscription(subscription_id, params);
      return {
        data: { executed: true, dry_run: false, subscription_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Updated subscription ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
