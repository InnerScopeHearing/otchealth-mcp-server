import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { confirmPaymentIntent } from '../../stripe/full-client.js';

export function registerStripePaymentIntentConfirm(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_intent_confirm',
    category: 'write_orchestrated',
    annotations: {
      title: 'Confirm Stripe payment intent',
      description: 'Confirm a payment intent to initiate payment. Money movement. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      payment_intent_id: z.string().describe('Payment intent ID (pi_...).'),
      payment_method: z.string().optional().describe('Payment method ID to use for confirmation.'),
      return_url: z.string().url().optional().describe('Return URL for redirect-based payment methods.'),
      off_session: z.boolean().optional().describe('Set true if charging without customer present.'),
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
          summary: `DRY RUN: would confirm payment intent ${input.payment_intent_id}. Pass dry_run=false to apply.`,
        };
      }
      const { payment_intent_id, ...params } = input;
      const upstream = await confirmPaymentIntent(payment_intent_id, params);
      return {
        data: { executed: true, dry_run: false, payment_intent_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Confirmed payment intent ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
