import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFulfillment } from '../../shopify/full-client.js';

export function registerShopifyFulfillmentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_fulfillment_get',
    category: 'read',
    annotations: {
      title: 'Get a fulfillment',
      description: 'Retrieve a single fulfillment by order and fulfillment ID via GET /orders/{id}/fulfillments/{fulfillment_id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      order_id: z.union([z.string(), z.number()]).describe('Shopify order ID.'),
      fulfillment_id: z.union([z.string(), z.number()]).describe('Shopify fulfillment ID.'),
    },
    outputShape: {
      fulfillment: z.unknown(),
    },
    handler: async (input, ctx) => {
      const fulfillment = await getFulfillment(input.order_id, input.fulfillment_id, { correlationId: ctx.correlationId });
      return { data: { fulfillment }, summary: `Retrieved fulfillment ${input.fulfillment_id} for order ${input.order_id}.` };
    },
  }, callerHash);
}
