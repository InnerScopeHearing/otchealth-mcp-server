import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCreditNotes } from '../../stripe/full-client.js';

export function registerStripeCreditNoteList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_credit_note_list',
    category: 'read',
    annotations: {
      title: 'List Stripe credit notes',
      description: 'List credit notes, optionally filtered by invoice or customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      invoice: z.string().optional().describe('Filter by invoice ID.'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      credit_notes: z.array(z.object({
        id: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.string(),
        invoice: z.string(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCreditNotes({
        limit: input.limit ?? 10,
        invoice: input.invoice,
        customer: input.customer,
        starting_after: input.starting_after,
      });
      const credit_notes = (result.data ?? []).map((cn: any) => ({
        id: cn.id,
        amount: cn.amount,
        currency: cn.currency,
        status: cn.status,
        invoice: typeof cn.invoice === 'string' ? cn.invoice : cn.invoice?.id,
        created: new Date(cn.created * 1000).toISOString(),
      }));
      return {
        data: { credit_notes, count: credit_notes.length, has_more: result.has_more ?? false },
        summary: `Found ${credit_notes.length} credit note(s).`,
      };
    },
  }, callerHash);
}
