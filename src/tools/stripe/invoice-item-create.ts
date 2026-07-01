import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createInvoiceItem } from '../../stripe/full-client.js';

export function registerStripeInvoiceItemCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_item_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe invoice item',
      description: 'Add a line item to an upcoming invoice. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      customer: z.string().describe('Customer ID (cus_...).'),
      amount: z.number().int().optional().describe('Amount in cents (required if price is not set).'),
      currency: z.string().length(3).optional().describe('ISO 4217 currency code (e.g. usd).'),
      description: z.string().optional().describe('Line item description.'),
      invoice: z.string().optional().describe('Invoice ID to add to. If omitted, adds to next invoice.'),
      price: z.string().optional().describe('Price ID — use instead of amount/currency.'),
      quantity: z.number().int().min(1).optional().describe('Quantity (default 1).'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      item_id: z.string().nullable(),
      customer: z.string().nullable(),
      amount: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, item_id: null, customer: input.customer, amount: input.amount ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create invoice item for customer ${input.customer}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createInvoiceItem({
        customer: input.customer,
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        invoice: input.invoice,
        price: input.price,
        quantity: input.quantity,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, item_id: upstream.id, customer: upstream.customer, amount: upstream.amount ?? null },
        audit: { before: null, after: input },
        summary: `Created invoice item ${upstream.id} for customer ${upstream.customer}.`,
      };
    },
  }, callerHash);
}
