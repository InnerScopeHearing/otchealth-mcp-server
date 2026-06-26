import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getInventoryItem } from '../../shopify/full-client.js';

export function registerShopifyInventoryItemGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_inventory_item_get',
    category: 'read',
    annotations: {
      title: 'Get an inventory item',
      description: 'Retrieve a single inventory item (SKU, tracking, cost, country of origin) via GET /inventory_items/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      inventory_item_id: z.union([z.string(), z.number()]).describe('Shopify inventory item ID.'),
    },
    outputShape: {
      inventory_item: z.unknown(),
    },
    handler: async (input, ctx) => {
      const inventory_item = await getInventoryItem(input.inventory_item_id, { correlationId: ctx.correlationId });
      return { data: { inventory_item }, summary: `Retrieved inventory item ${input.inventory_item_id}.` };
    },
  }, callerHash);
}
