import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { detachPaymentMethod } from '../../stripe/full-client.js';

export function registerStripePaymentMethodDetach(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_payment_method_detach',
    category: 'write_simple',
    annotations: {
      title: 'Detach Stripe payment method from customer',
      description: 'Detach a payment method from its customer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      payment_method_id: z.string().describe('Payment method ID (pm_...) to detach.'),
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
          data: { executed: false, dry_run: true, payment_method_id: input.payment_method_id, customer: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would detach payment method ${input.payment_method_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await detachPaymentMethod(input.payment_method_id);
      return {
        data: { executed: true, dry_run: false, payment_method_id: upstream.id, customer: upstream.customer ?? null },
        audit: { before: null, after: input },
        summary: `Detached payment method ${upstream.id} from customer.`,
      };
    },
  }, callerHash);
}
