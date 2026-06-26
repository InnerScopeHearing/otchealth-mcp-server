import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { adjustInventoryLevel } from '../../shopify/full-client.js';

export function registerShopifyInventoryLevelAdjust(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_inventory_level_adjust',
    category: 'write_simple',
    annotations: {
      title: 'Adjust inventory level by delta',
      description: 'Adjust inventory quantity by a relative delta (positive or negative) via POST /inventory_levels/adjust.json. Use shopify_update_inventory_level to SET an absolute value. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      location_id: z.union([z.string(), z.number()]).describe('Shopify location ID.'),
      inventory_item_id: z.union([z.string(), z.number()]).describe('Shopify inventory item ID.'),
      available_adjustment: z.number().int().describe('Delta to apply, e.g. -5 to decrease by 5, +10 to increase by 10.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      inventory_level: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, inventory_level: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would adjust inventory item ${input.inventory_item_id} at location ${input.location_id} by ${input.available_adjustment}. Pass dry_run=false to apply.`,
        };
      }
      const inventory_level = await adjustInventoryLevel(input.location_id, input.inventory_item_id, input.available_adjustment, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, inventory_level },
        audit: { before: null, after: input },
        summary: `Inventory for item ${input.inventory_item_id} at location ${input.location_id} adjusted by ${input.available_adjustment}.`,
      };
    },
  }, callerHash);
}
