import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteInvoiceItem } from '../../stripe/full-client.js';

export function registerStripeInvoiceItemDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_item_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Stripe invoice item',
      description: 'Delete an invoice line item. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_item_id: z.string().describe('Invoice item ID (ii_...) to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      item_id: z.string().nullable(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, item_id: input.invoice_item_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete invoice item ${input.invoice_item_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteInvoiceItem(input.invoice_item_id);
      return {
        data: { executed: true, dry_run: false, item_id: upstream.id, deleted: upstream.deleted ?? true },
        audit: { before: null, after: input },
        summary: `Deleted invoice item ${input.invoice_item_id}.`,
      };
    },
  }, callerHash);
}
