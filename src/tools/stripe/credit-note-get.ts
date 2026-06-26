import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCreditNote } from '../../stripe/full-client.js';

export function registerStripeCreditNoteGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_credit_note_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe credit note',
      description: 'Retrieve a single credit note by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      credit_note_id: z.string().describe('Credit note ID (cn_...).'),
    },
    outputShape: {
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.string(),
      invoice: z.string(),
      reason: z.string().nullable(),
      pdf: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const cn = await getCreditNote(input.credit_note_id);
      return {
        data: {
          id: cn.id,
          amount: cn.amount,
          currency: cn.currency,
          status: cn.status,
          invoice: typeof cn.invoice === 'string' ? cn.invoice : cn.invoice?.id,
          reason: cn.reason ?? null,
          pdf: cn.pdf ?? null,
          created: new Date(cn.created * 1000).toISOString(),
        },
        summary: `Credit note ${cn.id}: ${cn.status}, ${cn.currency} ${cn.amount / 100}.`,
      };
    },
  }, callerHash);
}
