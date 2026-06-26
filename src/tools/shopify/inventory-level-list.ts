import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listInventoryLevels } from '../../shopify/full-client.js';

export function registerShopifyInventoryLevelList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_inventory_level_list',
    category: 'read',
    annotations: {
      title: 'List inventory levels',
      description: 'Retrieve inventory levels for specified items or locations via GET /inventory_levels.json. At least one of inventory_item_ids or location_ids is required by Shopify.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      inventory_item_ids: z.string().optional().describe('Comma-separated inventory item IDs to filter by.'),
      location_ids: z.string().optional().describe('Comma-separated location IDs to filter by.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      updated_at_min: z.string().optional().describe('ISO 8601 min updated date.'),
    },
    outputShape: {
      inventory_levels: z.unknown(),
    },
    handler: async (input, ctx) => {
      const inventory_levels = await listInventoryLevels(input, { correlationId: ctx.correlationId });
      return { data: { inventory_levels }, summary: `Listed inventory levels.` };
    },
  }, callerHash);
}
