import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomers } from '../../shopify/full-client.js';

export function registerShopifyCustomerList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_list',
    category: 'read',
    annotations: {
      title: 'List Shopify customers',
      description: 'Retrieve a paginated list of customers via GET /customers.json. Filter by date ranges or specific IDs.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max customers to return (1-250, default 50).'),
      page_info: z.string().optional().describe('Pagination cursor from a previous response.'),
      ids: z.string().optional().describe('Comma-separated customer IDs.'),
      created_at_min: z.string().optional().describe('ISO 8601 min created date.'),
      created_at_max: z.string().optional().describe('ISO 8601 max created date.'),
      updated_at_min: z.string().optional().describe('ISO 8601 min updated date.'),
      updated_at_max: z.string().optional().describe('ISO 8601 max updated date.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      customers: z.unknown(),
    },
    handler: async (input, ctx) => {
      const customers = await listCustomers(input as any, { correlationId: ctx.correlationId });
      return { data: { customers }, summary: `Listed customers.` };
    },
  }, callerHash);
}
