import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFulfillments } from '../../shopify/full-client.js';

export function registerShopifyFulfillmentList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_fulfillment_list',
    category: 'read',
    annotations: {
      title: 'List fulfillments for an order',
      description: 'Retrieve all fulfillments for a specific order via GET /orders/{id}/fulfillments.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
      created_at_min: z.string().optional().describe('ISO 8601 min created date.'),
      created_at_max: z.string().optional().describe('ISO 8601 max created date.'),
    },
    outputShape: {
      fulfillments: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { order_id, ...params } = input;
      const fulfillments = await listFulfillments(order_id, params, { correlationId: ctx.correlationId });
      return { data: { fulfillments }, summary: `Listed fulfillments for order ${order_id}.` };
    },
  }, callerHash);
}
