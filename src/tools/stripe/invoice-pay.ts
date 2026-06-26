import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { payInvoice } from '../../stripe/full-client.js';

export function registerStripeInvoicePay(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_pay',
    category: 'write_orchestrated',
    annotations: {
      title: 'Pay Stripe invoice',
      description: 'Trigger payment on an open invoice. Money movement — requires CTO approval. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Invoice ID (in_...) to pay.'),
      payment_method: z.string().optional().describe('Payment method ID to charge.'),
      forgive: z.boolean().optional().describe('If true, forgive the invoice balance on failure.'),
      off_session: z.boolean().optional().describe('Set true if charging in an automated context.'),
      paid_out_of_band: z.boolean().optional().describe('Mark as paid outside of Stripe.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      invoice_id: z.string().nullable(),
      status: z.string().nullable(),
      amount_paid: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, invoice_id: input.invoice_id, status: null, amount_paid: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would pay invoice ${input.invoice_id}. Pass dry_run=false to apply.`,
        };
      }
      const { invoice_id, ...params } = input;
      const upstream = await payInvoice(invoice_id, params);
      return {
        data: {
          executed: true,
          dry_run: false,
          invoice_id: upstream.id,
          status: upstream.status,
          amount_paid: upstream.amount_paid ?? null,
        },
        audit: { before: null, after: input },
        summary: `Paid invoice ${upstream.id}. Status: ${upstream.status}.`,
      };
    },
  }, callerHash);
}
