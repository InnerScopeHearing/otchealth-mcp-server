import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomerInvoices } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerListInvoices(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_list_invoices',
    category: 'read',
    annotations: {
      title: 'List customer invoices',
      description: 'List all invoices for a customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      customer_id: z.string().describe('Customer ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { invoices: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listCustomerInvoices(input.project_id, input.customer_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.invoices ?? [];
      return { data: { invoices: items, count: items.length }, summary: `${items.length} invoice(s) for ${input.customer_id}.` };
    },
  }, callerHash);
}
