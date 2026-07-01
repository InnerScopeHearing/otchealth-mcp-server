import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelPaymentIntent } from '../../stripe/full-client.js';

export function registerStripePaymentIntentCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_intent_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Cancel Stripe payment intent',
      description: 'Cancel a payment intent. Irreversible once applied. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      payment_intent_id: z.string().describe('Payment intent ID (pi_...) to cancel.'),
      cancellation_reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned']).optional(),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      payment_intent_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, payment_intent_id: input.payment_intent_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel payment intent ${input.payment_intent_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await cancelPaymentIntent(input.payment_intent_id, input.cancellation_reason);
      return {
        data: { executed: true, dry_run: false, payment_intent_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Cancelled payment intent ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
