import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendDraftOrderInvoice } from '../../shopify/full-client.js';

export function registerShopifyDraftOrderSendInvoice(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_draft_order_send_invoice',
    category: 'write_simple',
    annotations: {
      title: 'Send draft order invoice',
      description: 'Send a payment invoice email for a draft order to the customer via POST /draft_orders/{id}/send_invoice.json. Triggers outbound email. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      draft_order_id: z.union([z.string(), z.number()]).describe('Shopify draft order ID.'),
      to: z.string().email().optional().describe('Recipient email address. Defaults to customer email on the draft order.'),
      from: z.string().email().optional().describe('Sender email address. Defaults to shop email.'),
      bcc: z.array(z.string().email()).optional().describe('BCC email addresses.'),
      subject: z.string().optional().describe('Email subject line.'),
      custom_message: z.string().optional().describe('Custom message body to include in the invoice email.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      draft_order_invoice: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, draft_order_invoice: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would send invoice for draft order ${input.draft_order_id} to ${input.to ?? 'customer default email'}. Pass dry_run=false to apply.`,
        };
      }
      const { draft_order_id, ...invoice } = input;
      const draft_order_invoice = await sendDraftOrderInvoice(draft_order_id, invoice, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, draft_order_invoice },
        audit: { before: null, after: input },
        summary: `Invoice sent for draft order ${draft_order_id}.`,
      };
    },
  }, callerHash);
}
