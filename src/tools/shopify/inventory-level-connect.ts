import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { connectInventoryLevel } from '../../shopify/full-client.js';

export function registerShopifyInventoryLevelConnect(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_inventory_level_connect',
    category: 'write_simple',
    annotations: {
      title: 'Connect inventory item to location',
      description: 'Connect an inventory item to a location (enables tracking at that location) via POST /inventory_levels/connect.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      location_id: z.union([z.string(), z.number()]).describe('Shopify location ID.'),
      inventory_item_id: z.union([z.string(), z.number()]).describe('Shopify inventory item ID.'),
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
          summary: `DRY RUN: would connect inventory item ${input.inventory_item_id} to location ${input.location_id}. Pass dry_run=false to apply.`,
        };
      }
      const inventory_level = await connectInventoryLevel(input.location_id, input.inventory_item_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, inventory_level },
        audit: { before: null, after: input },
        summary: `Inventory item ${input.inventory_item_id} connected to location ${input.location_id}.`,
      };
    },
  }, callerHash);
}
