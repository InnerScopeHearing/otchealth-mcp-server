import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteInvoiceDraft } from '../../stripe/full-client.js';

export function registerStripeInvoiceDeleteDraft(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_delete_draft',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Stripe draft invoice',
      description: 'Permanently delete a draft invoice. Only allowed on draft status. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Draft invoice ID (in_...) to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      invoice_id: z.string().nullable(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, invoice_id: input.invoice_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete draft invoice ${input.invoice_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteInvoiceDraft(input.invoice_id);
      return {
        data: { executed: true, dry_run: false, invoice_id: upstream.id, deleted: upstream.deleted ?? true },
        audit: { before: null, after: input },
        summary: `Deleted draft invoice ${input.invoice_id}.`,
      };
    },
  }, callerHash);
}
