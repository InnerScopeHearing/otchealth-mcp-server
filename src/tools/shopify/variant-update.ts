import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProductVariant } from '../../shopify/full-client.js';

export function registerShopifyVariantUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_variant_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a product variant',
      description: 'Update fields on an existing variant via PUT /variants/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      variant_id: z.union([z.string(), z.number()]).describe('Shopify variant ID to update.'),
      option1: z.string().optional().describe('Value for option1 (e.g. "Large").'),
      option2: z.string().optional().describe('Value for option2.'),
      option3: z.string().optional().describe('Value for option3.'),
      price: z.string().optional().describe('Variant price, e.g. "29.99".'),
      sku: z.string().optional().describe('Stock-keeping unit.'),
      barcode: z.string().optional().describe('Barcode (ISBN, UPC, GTIN, etc.).'),
      inventory_management: z.enum(['shopify', 'not_managed']).optional().describe('"shopify" to track inventory.'),
      inventory_policy: z.enum(['deny', 'continue']).optional().describe('Whether to allow purchase when out of stock.'),
      taxable: z.boolean().optional().describe('Whether the variant is taxable.'),
      weight: z.number().optional().describe('Weight of the variant.'),
      weight_unit: z.enum(['g', 'kg', 'oz', 'lb']).optional().describe('Weight unit.'),
      requires_shipping: z.boolean().optional().describe('Whether the variant requires shipping.'),
      compare_at_price: z.string().nullable().optional().describe('Compare-at (was) price.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      variant: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, variant: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update variant ${input.variant_id}. Pass dry_run=false to apply.`,
        };
      }
      const { variant_id, ...patch } = input;
      const variant = await updateProductVariant(variant_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, variant },
        audit: { before: null, after: input },
        summary: `Variant ${variant_id} updated.`,
      };
    },
  }, callerHash);
}
