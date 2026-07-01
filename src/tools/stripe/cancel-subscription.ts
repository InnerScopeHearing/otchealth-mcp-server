/**
 * stripe_cancel_subscription — DELETE /v1/subscriptions/{id}
 *
 * Category: write_orchestrated (terminates recurring revenue; hard-cancel is irreversible;
 * triggers proration/refund logic and dunning stop). CTO-gated per governance policy.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelSubscription } from '../../stripe/write-client.js';

export function registerStripeCancelSubscription(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'stripe_cancel_subscription',
      category: 'write_orchestrated',
      annotations: {
        title: 'Cancel Stripe subscription',
        description:
          'Cancel an active Stripe subscription. By default cancels immediately (destructive, stops ' +
          'recurring billing at once). Set cancel_at_period_end=true to cancel at the end of the ' +
          'current billing period instead. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        subscription_id: z
          .string()
          .min(1)
          .describe('Stripe subscription ID to cancel (sub_…).'),
        cancel_at_period_end: z
          .boolean()
          .optional()
          .describe(
            'If true, subscription stays active until the end of the current billing period, then cancels. ' +
            'Default false = immediate cancellation.',
          ),
        prorate: z
          .boolean()
          .optional()
          .describe('Whether to prorate charges. Only applies to immediate cancellations. Default true in Stripe.'),
        invoice_now: z
          .boolean()
          .optional()
          .describe('If true, Stripe creates and finalizes a final invoice immediately on cancellation. Default false.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        subscription_id: z.string(),
        status: z.string().nullable(),
        cancel_at_period_end: z.boolean().nullable(),
        canceled_at: z.string().nullable(),
        current_period_end: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        const mode = input.cancel_at_period_end ? 'at period end' : 'immediately';

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              subscription_id: input.subscription_id,
              status: null,
              cancel_at_period_end: input.cancel_at_period_end ?? false,
              canceled_at: null,
              current_period_end: null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would cancel subscription ${input.subscription_id} ${mode}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await cancelSubscription({
          subscriptionId: input.subscription_id,
          cancel_at_period_end: input.cancel_at_period_end,
          prorate: input.prorate,
          invoice_now: input.invoice_now,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            subscription_id: upstream.id ?? input.subscription_id,
            status: upstream.status ?? null,
            cancel_at_period_end: upstream.cancel_at_period_end ?? null,
            canceled_at: upstream.canceled_at
              ? new Date(upstream.canceled_at * 1000).toISOString()
              : null,
            current_period_end: upstream.current_period_end
              ? new Date(upstream.current_period_end * 1000).toISOString()
              : null,
          },
          audit: { before: null, after: input },
          summary: `Subscription ${upstream.id ?? input.subscription_id} cancelled ${mode} — status: ${upstream.status}.`,
        };
      },
    },
    callerHash,
  );
}
