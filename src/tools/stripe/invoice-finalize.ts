import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { finalizeInvoice } from '../../stripe/full-client.js';

export function registerStripeInvoiceFinalize(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_finalize',
    category: 'write_simple',
    annotations: {
      title: 'Finalize Stripe invoice',
      description: 'Finalize a draft invoice, making it ready to send. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Invoice ID (in_...).'),
      auto_advance: z.boolean().optional().describe('Controls automatic collection after finalization.'),
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
          summary: `DRY RUN: would finalize invoice ${input.invoice_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await finalizeInvoice(input.invoice_id, input.auto_advance);
      return {
        data: { executed: true, dry_run: false, invoice_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Finalized invoice ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
