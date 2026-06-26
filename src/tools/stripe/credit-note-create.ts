import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCreditNote } from '../../stripe/full-client.js';

export function registerStripeCreditNoteCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_credit_note_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Stripe credit note',
      description: 'Issue a credit note against a finalized invoice. Money movement — reduces amount owed. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      invoice: z.string().describe('Invoice ID (in_...) to credit.'),
      amount: z.number().int().min(1).optional().describe('Total credit amount in cents.'),
      credit_amount: z.number().int().min(0).optional().describe('Amount to credit to customer balance.'),
      out_of_band_amount: z.number().int().min(0).optional().describe('Amount credited out of band (outside Stripe).'),
      refund_amount: z.number().int().min(0).optional().describe('Amount to refund to original payment method.'),
      reason: z.enum(['duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory']).optional(),
      memo: z.string().optional().describe('Memo displayed on credit note.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      credit_note_id: z.string().nullable(),
      status: z.string().nullable(),
      amount: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, credit_note_id: null, status: null, amount: input.amount ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create credit note against invoice ${input.invoice}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createCreditNote({
        invoice: input.invoice,
        amount: input.amount,
        credit_amount: input.credit_amount,
        out_of_band_amount: input.out_of_band_amount,
        refund_amount: input.refund_amount,
        reason: input.reason,
        memo: input.memo,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, credit_note_id: upstream.id, status: upstream.status, amount: upstream.amount ?? null },
        audit: { before: null, after: input },
        summary: `Created credit note ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
