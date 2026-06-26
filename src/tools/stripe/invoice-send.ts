import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendInvoice } from '../../stripe/full-client.js';

export function registerStripeInvoiceSend(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_send',
    category: 'write_simple',
    annotations: {
      title: 'Send Stripe invoice',
      description: 'Send a finalized invoice to the customer by email. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Invoice ID (in_...) to send.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      invoice_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, invoice_id: input.invoice_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would send invoice ${input.invoice_id} to customer. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await sendInvoice(input.invoice_id);
      return {
        data: { executed: true, dry_run: false, invoice_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Sent invoice ${upstream.id} to customer.`,
      };
    },
  }, callerHash);
}
