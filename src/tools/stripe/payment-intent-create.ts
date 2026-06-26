import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPaymentIntent } from '../../stripe/full-client.js';

export function registerStripePaymentIntentCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_intent_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Stripe payment intent',
      description: 'Create a new payment intent. Money movement — requires CTO approval. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      amount: z.number().int().min(1).describe('Amount in cents (smallest currency unit).'),
      currency: z.string().length(3).describe('ISO 4217 currency code (e.g. usd).'),
      customer: z.string().optional().describe('Customer ID (cus_...).'),
      payment_method: z.string().optional().describe('Payment method ID (pm_...).'),
      description: z.string().optional().describe('Description for the payment.'),
      confirm: z.boolean().optional().describe('Confirm immediately if true.'),
      return_url: z.string().url().optional().describe('Return URL after confirmation.'),
      receipt_email: z.string().email().optional().describe('Email to send receipt to.'),
      statement_descriptor: z.string().max(22).optional().describe('Statement descriptor (max 22 chars).'),
      capture_method: z.enum(['automatic', 'automatic_async', 'manual']).optional(),
      setup_future_usage: z.enum(['off_session', 'on_session']).optional(),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      payment_intent_id: z.string().nullable(),
      status: z.string().nullable(),
      client_secret: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, payment_intent_id: null, status: null, client_secret: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create payment intent for ${input.currency} ${input.amount / 100}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createPaymentIntent({
        amount: input.amount,
        currency: input.currency,
        customer: input.customer,
        payment_method: input.payment_method,
        description: input.description,
        confirm: input.confirm,
        return_url: input.return_url,
        receipt_email: input.receipt_email,
        statement_descriptor: input.statement_descriptor,
        capture_method: input.capture_method,
        setup_future_usage: input.setup_future_usage,
        metadata: input.metadata,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          payment_intent_id: upstream.id,
          status: upstream.status,
          client_secret: upstream.client_secret ?? null,
        },
        audit: { before: null, after: input },
        summary: `Created payment intent ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
