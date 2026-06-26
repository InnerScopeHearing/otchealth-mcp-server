import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { countOrders } from '../../shopify/full-client.js';

export function registerShopifyOrderCount(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_order_count',
    category: 'read',
    annotations: {
      title: 'Count Shopify orders',
      description: 'Return a count of orders matching the given filters via GET /orders/count.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      status: z.enum(['open', 'closed', 'cancelled', 'any']).optional().default('any').describe('Order status filter.'),
      financial_status: z.enum(['authorized', 'pending', 'paid', 'partially_paid', 'refunded', 'voided', 'partially_refunded', 'any', 'unpaid']).optional().describe('Financial status filter.'),
      fulfillment_status: z.enum(['shipped', 'partial', 'unshipped', 'any', 'unfulfilled']).optional().describe('Fulfillment status filter.'),
    },
    outputShape: {
      count: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      const result = await countOrders(input, { correlationId: ctx.correlationId }) as { count?: number };
      return { data: { count: result.count ?? null }, summary: `Order count: ${result.count ?? 'unknown'}.` };
    },
  }, callerHash);
}
