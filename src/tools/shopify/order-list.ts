import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listOrders } from '../../shopify/full-client.js';

export function registerShopifyOrderList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_order_list',
    category: 'read',
    annotations: {
      title: 'List Shopify orders',
      description: 'Retrieve a paginated list of orders from Shopify Admin API GET /orders.json. Filter by status, financial status, fulfillment status, and date ranges.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max orders to return (1-250, default 50).'),
      page_info: z.string().optional().describe('Pagination cursor from a previous response.'),
      status: z.enum(['open', 'closed', 'cancelled', 'any']).optional().default('any').describe('Order status filter.'),
      financial_status: z.enum(['authorized', 'pending', 'paid', 'partially_paid', 'refunded', 'voided', 'partially_refunded', 'any', 'unpaid']).optional().describe('Financial status filter.'),
      fulfillment_status: z.enum(['shipped', 'partial', 'unshipped', 'any', 'unfulfilled']).optional().describe('Fulfillment status filter.'),
      created_at_min: z.string().optional().describe('ISO 8601 min created date, e.g. "2024-01-01T00:00:00Z".'),
      created_at_max: z.string().optional().describe('ISO 8601 max created date.'),
      updated_at_min: z.string().optional().describe('ISO 8601 min updated date.'),
      updated_at_max: z.string().optional().describe('ISO 8601 max updated date.'),
      ids: z.string().optional().describe('Comma-separated list of order IDs to retrieve.'),
      fields: z.string().optional().describe('Comma-separated list of fields to return.'),
    },
    outputShape: {
      orders: z.unknown(),
    },
    handler: async (input, ctx) => {
      const orders = await listOrders(input as any, { correlationId: ctx.correlationId });
      return { data: { orders }, summary: `Listed orders.` };
    },
  }, callerHash);
}
