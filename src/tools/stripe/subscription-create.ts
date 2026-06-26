import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSubscription } from '../../stripe/full-client.js';

export function registerStripeSubscriptionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Stripe subscription',
      description: 'Create a new subscription for a customer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      customer: z.string().describe('Customer ID (cus_...).'),
      items: z.array(z.object({
        price: z.string().describe('Price ID (price_...).'),
        quantity: z.number().int().min(1).optional().describe('Quantity (default 1).'),
      })).describe('Subscription line items.'),
      trial_period_days: z.number().int().min(0).optional().describe('Number of trial days.'),
      cancel_at_period_end: z.boolean().optional().describe('Cancel at end of billing period.'),
      collection_method: z.enum(['charge_automatically', 'send_invoice']).optional(),
      coupon: z.string().optional().describe('Coupon ID to apply.'),
      promotion_code: z.string().optional().describe('Promotion code ID to apply.'),
      default_payment_method: z.string().optional().describe('Payment method ID to use.'),
      description: z.string().optional().describe('Subscription description.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      subscription_id: z.string().nullable(),
      status: z.string().nullable(),
      customer: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, subscription_id: null, status: null, customer: input.customer },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create subscription for customer ${input.customer}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createSubscription({
        customer: input.customer,
        items: input.items,
        trial_period_days: input.trial_period_days,
        cancel_at_period_end: input.cancel_at_period_end,
        collection_method: input.collection_method,
        coupon: input.coupon,
        promotion_code: input.promotion_code,
        default_payment_method: input.default_payment_method,
        description: input.description,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, subscription_id: upstream.id, status: upstream.status, customer: upstream.customer },
        audit: { before: null, after: input },
        summary: `Created subscription ${upstream.id} (${upstream.status}) for customer ${upstream.customer}.`,
      };
    },
  }, callerHash);
}
