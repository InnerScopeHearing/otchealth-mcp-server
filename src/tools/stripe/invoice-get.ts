import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getInvoice } from '../../stripe/full-client.js';

export function registerStripeInvoiceGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe invoice',
      description: 'Retrieve a single invoice by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      invoice_id: z.string().describe('Invoice ID (in_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string().nullable(),
      customer: z.string(),
      amount_due: z.number(),
      amount_paid: z.number(),
      currency: z.string(),
      created: z.string(),
      hosted_invoice_url: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const inv = await getInvoice(input.invoice_id);
      return {
        data: {
          id: inv.id,
          status: inv.status ?? null,
          customer: inv.customer,
          amount_due: inv.amount_due ?? 0,
          amount_paid: inv.amount_paid ?? 0,
          currency: inv.currency,
          created: new Date(inv.created * 1000).toISOString(),
          hosted_invoice_url: inv.hosted_invoice_url ?? null,
        },
        summary: `Invoice ${inv.id} status: ${inv.status}.`,
      };
    },
  }, callerHash);
}
