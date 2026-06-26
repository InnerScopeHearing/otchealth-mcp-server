import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateInventoryItem } from '../../shopify/full-client.js';

export function registerShopifyInventoryItemUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_inventory_item_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an inventory item',
      description: 'Update SKU, tracking, cost, or country of origin on an inventory item via PUT /inventory_items/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      inventory_item_id: z.union([z.string(), z.number()]).describe('Shopify inventory item ID to update.'),
      sku: z.string().optional().describe('Stock-keeping unit.'),
      tracked: z.boolean().optional().describe('Whether to track inventory for this item.'),
      cost: z.string().optional().describe('Unit cost, e.g. "12.50". Used for cost of goods reporting.'),
      country_code_of_origin: z.string().optional().describe('ISO 3166-1 alpha-2 country code of origin, e.g. "US".'),
      province_code_of_origin: z.string().optional().describe('Province/state code of origin.'),
      harmonized_system_code: z.string().optional().describe('HS tariff code.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      inventory_item: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, inventory_item: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update inventory item ${input.inventory_item_id}. Pass dry_run=false to apply.`,
        };
      }
      const { inventory_item_id, ...patch } = input;
      const inventory_item = await updateInventoryItem(inventory_item_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, inventory_item },
        audit: { before: null, after: input },
        summary: `Inventory item ${inventory_item_id} updated.`,
      };
    },
  }, callerHash);
}
