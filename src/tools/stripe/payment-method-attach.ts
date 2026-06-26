import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { attachPaymentMethod } from '../../stripe/full-client.js';

export function registerStripePaymentMethodAttach(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_method_attach',
    category: 'write_simple',
    annotations: {
      title: 'Attach Stripe payment method to customer',
      description: 'Attach a payment method to a customer for future use. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      payment_method_id: z.string().describe('Payment method ID (pm_...) to attach.'),
      customer_id: z.string().describe('Customer ID (cus_...) to attach it to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      payment_method_id: z.string().nullable(),
      customer: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, payment_method_id: input.payment_method_id, customer: input.customer_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would attach payment method ${input.payment_method_id} to customer ${input.customer_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await attachPaymentMethod(input.payment_method_id, input.customer_id);
      return {
        data: { executed: true, dry_run: false, payment_method_id: upstream.id, customer: upstream.customer ?? null },
        audit: { before: null, after: input },
        summary: `Attached payment method ${upstream.id} to customer ${upstream.customer}.`,
      };
    },
  }, callerHash);
}
