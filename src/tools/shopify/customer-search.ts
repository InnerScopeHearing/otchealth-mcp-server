import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { searchCustomers } from '../../shopify/full-client.js';

export function registerShopifyCustomerSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_search',
    category: 'read',
    annotations: {
      title: 'Search Shopify customers',
      description: 'Search customers by name, email, or other fields via GET /customers/search.json. Supports Shopify query syntax.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      query: z.string().min(1).describe('Search query, e.g. "email:john@example.com" or "John Smith". Supports Shopify search syntax.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results (1-250, default 50).'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
      order: z.string().optional().describe('Sort order, e.g. "last_order_date DESC".'),
    },
    outputShape: {
      customers: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { query, ...params } = input;
      const customers = await searchCustomers(query, params, { correlationId: ctx.correlationId });
      return { data: { customers }, summary: `Customer search completed for "${query}".` };
    },
  }, callerHash);
}
