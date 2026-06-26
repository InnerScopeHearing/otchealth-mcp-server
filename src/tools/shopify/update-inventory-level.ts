import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateInventoryLevel } from '../../shopify/write-client.js';

export function registerShopifyUpdateInventoryLevel(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_update_inventory_level',
      category: 'write_simple',
      annotations: {
        title: 'Set Shopify inventory level',
        description:
          'Set the available inventory count for a specific inventory item at a specific location ' +
          'via POST /inventory_levels/set.json. Use shopify_list_products to find inventory_item_id ' +
          '(on each variant) and shopify_get_order or Admin > Locations to find location_id. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        inventory_item_id: z
          .number()
          .int()
          .positive()
          .describe(
            'Inventory item ID from the product variant (variant.inventory_item_id). ' +
              'Obtain via shopify_list_products or shopify_get_product.',
          ),
        location_id: z
          .number()
          .int()
          .positive()
          .describe(
            'Location ID where inventory is stored. ' +
              'Find via GET /locations.json in Shopify Admin or the admin UI.',
          ),
        available: z
          .number()
          .int()
          .describe(
            'New absolute available quantity (not a delta). ' +
              'Must be >= 0 or -1 to represent unlimited stock.',
          ),
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
            summary:
              `DRY RUN: would set inventory_item ${input.inventory_item_id} ` +
              `at location ${input.location_id} to ${input.available} units. Pass dry_run=false to apply.`,
          };
        }
        const inventory_level = await updateInventoryLevel({
          inventory_item_id: input.inventory_item_id,
          location_id: input.location_id,
          available: input.available,
          correlationId: ctx.correlationId,
        });
        return {
          data: { executed: true, dry_run: false, inventory_level },
          audit: { before: null, after: input },
          summary:
            `Inventory for item ${input.inventory_item_id} at location ${input.location_id} ` +
            `set to ${input.available}.`,
        };
      },
    },
    callerHash,
  );
}
