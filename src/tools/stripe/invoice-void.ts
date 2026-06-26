import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { voidInvoice } from '../../stripe/full-client.js';

export function registerStripeInvoiceVoid(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_void',
    category: 'write_orchestrated',
    annotations: {
      title: 'Void Stripe invoice',
      description: 'Void a finalized invoice. Irreversible — changes status to void. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Invoice ID (in_...) to void.'),
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
          summary: `DRY RUN: would void invoice ${input.invoice_id}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await voidInvoice(input.invoice_id);
      return {
        data: { executed: true, dry_run: false, invoice_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Voided invoice ${upstream.id}.`,
      };
    },
  }, callerHash);
}
