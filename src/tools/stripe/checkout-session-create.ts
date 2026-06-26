import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCheckoutSession } from '../../stripe/full-client.js';

export function registerStripeCheckoutSessionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_checkout_session_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe checkout session',
      description: 'Create a hosted checkout session for payment, subscription, or setup. Returns a URL to redirect the customer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      mode: z.enum(['payment', 'subscription', 'setup']).describe('Session mode.'),
      success_url: z.string().url().describe('URL to redirect to after successful checkout.'),
      cancel_url: z.string().url().optional().describe('URL to redirect to if customer cancels.'),
      line_items: z.array(z.object({
        price: z.string().describe('Price ID.'),
        quantity: z.number().int().min(1).describe('Quantity.'),
      })).optional().describe('Line items for payment/subscription modes.'),
      customer: z.string().optional().describe('Existing customer ID.'),
      customer_email: z.string().email().optional().describe('Pre-fill customer email.'),
      currency: z.string().length(3).optional().describe('Currency code (e.g. usd).'),
      allow_promotion_codes: z.boolean().optional().describe('Allow customers to enter promotion codes.'),
      billing_address_collection: z.enum(['auto', 'required']).optional(),
      locale: z.string().optional().describe('Locale code (e.g. en, fr).'),
      client_reference_id: z.string().optional().describe('Your internal reference ID.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      session_id: z.string().nullable(),
      url: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, session_id: null, url: null, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create ${input.mode} checkout session. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createCheckoutSession({
        mode: input.mode,
        success_url: input.success_url,
        cancel_url: input.cancel_url,
        line_items: input.line_items,
        customer: input.customer,
        customer_email: input.customer_email,
        currency: input.currency,
        allow_promotion_codes: input.allow_promotion_codes,
        billing_address_collection: input.billing_address_collection,
        locale: input.locale,
        client_reference_id: input.client_reference_id,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, session_id: upstream.id, url: upstream.url ?? null, status: upstream.status ?? null },
        audit: { before: null, after: input },
        summary: `Created checkout session ${upstream.id}. URL: ${upstream.url ?? 'N/A'}.`,
      };
    },
  }, callerHash);
}
