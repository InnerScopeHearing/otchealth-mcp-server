import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRefunds } from '../../shopify/full-client.js';

export function registerShopifyRefundList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_refund_list',
    category: 'read',
    annotations: {
      title: 'List refunds for an order',
      description: 'Retrieve all refunds for a specific order via GET /orders/{id}/refunds.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      refunds: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { order_id, ...params } = input;
      const refunds = await listRefunds(order_id, params, { correlationId: ctx.correlationId });
      return { data: { refunds }, summary: `Listed refunds for order ${order_id}.` };
    },
  }, callerHash);
}
