/**
 * stripe_create_refund — POST /v1/refunds
 *
 * Category: write_orchestrated (money movement — immediately returns cash to cardholder;
 * irreversible once processed). CTO-gated per governance policy.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createRefund } from '../../stripe/write-client.js';

export function registerStripeCreateRefund(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'stripe_create_refund',
      category: 'write_orchestrated',
      annotations: {
        title: 'Create Stripe refund',
        description:
          'Issue a refund for a Stripe charge or payment intent. Amount is in CENTS (omit to refund full amount). ' +
          'Irreversible once submitted — returns cash to the cardholder. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        charge: z
          .string()
          .optional()
          .describe('Stripe charge ID to refund (ch_…). Provide either charge or payment_intent.'),
        payment_intent: z
          .string()
          .optional()
          .describe('Stripe payment intent ID to refund (pi_…). Provide either charge or payment_intent.'),
        amount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Amount to refund in CENTS (e.g. 5000 = $50.00 USD). Omit to refund full amount.'),
        reason: z
          .enum(['duplicate', 'fraudulent', 'requested_by_customer'])
          .optional()
          .describe('Reason for refund. Required for fraud/duplicate for Stripe dispute protection.'),
        metadata: z
          .record(z.string())
          .optional()
          .describe('Key-value metadata to attach to the refund (max 50 keys).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        refund_id: z.string().nullable(),
        charge: z.string().nullable(),
        payment_intent: z.string().nullable(),
        amount_cents: z.number().nullable(),
        currency: z.string().nullable(),
        status: z.string().nullable(),
        reason: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        if (!input.charge && !input.payment_intent) {
          throw new Error('Must provide either charge or payment_intent.');
        }

        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              refund_id: null,
              charge: input.charge ?? null,
              payment_intent: input.payment_intent ?? null,
              amount_cents: input.amount ?? null,
              currency: null,
              status: null,
              reason: input.reason ?? null,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would refund ${input.amount ? `${input.amount} cents` : 'full amount'} on ${input.charge ?? input.payment_intent}. Pass dry_run=false to apply.`,
          };
        }

        const upstream = await createRefund({
          charge: input.charge,
          payment_intent: input.payment_intent,
          amount: input.amount,
          reason: input.reason,
          metadata: input.metadata,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            refund_id: upstream.id ?? null,
            charge: upstream.charge ?? null,
            payment_intent: upstream.payment_intent ?? null,
            amount_cents: upstream.amount ?? null,
            currency: upstream.currency ?? null,
            status: upstream.status ?? null,
            reason: upstream.reason ?? null,
          },
          audit: { before: null, after: input },
          summary: `Refund ${upstream.id} created — status: ${upstream.status}.`,
        };
      },
    },
    callerHash,
  );
}
