import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listInvoices } from '../../stripe/full-client.js';

export function registerStripeInvoiceList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_invoice_list',
    category: 'read',
    annotations: {
      title: 'List Stripe invoices',
      description: 'List invoices, optionally filtered by customer, status, or subscription.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional().describe('Filter by status.'),
      subscription: z.string().optional().describe('Filter by subscription ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      invoices: z.array(z.object({
        id: z.string(),
        status: z.string().nullable(),
        customer: z.string(),
        amount_due: z.number(),
        currency: z.string(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listInvoices({
        limit: input.limit ?? 10,
        customer: input.customer,
        status: input.status,
        subscription: input.subscription,
        starting_after: input.starting_after,
      });
      const invoices = (result.data ?? []).map((inv: any) => ({
        id: inv.id,
        status: inv.status ?? null,
        customer: inv.customer,
        amount_due: inv.amount_due ?? 0,
        currency: inv.currency,
        created: new Date(inv.created * 1000).toISOString(),
      }));
      return {
        data: { invoices, count: invoices.length, has_more: result.has_more ?? false },
        summary: `Found ${invoices.length} invoice(s).`,
      };
    },
  }, callerHash);
}
