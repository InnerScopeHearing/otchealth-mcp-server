import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProductVariant } from '../../shopify/full-client.js';

export function registerShopifyVariantCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_variant_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a product variant',
      description: 'Add a new variant to an existing product via POST /products/{id}/variants.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.union([z.string(), z.number()]).describe('Shopify product ID to add the variant to.'),
      option1: z.string().optional().describe('Value for option1 (e.g. "Small").'),
      option2: z.string().optional().describe('Value for option2 (e.g. "Red").'),
      option3: z.string().optional().describe('Value for option3.'),
      price: z.string().optional().describe('Variant price as string, e.g. "29.99".'),
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
          summary: `DRY RUN: would create variant for product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const { product_id, ...variant } = input;
      const result = await createProductVariant(product_id, variant, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, variant: result },
        audit: { before: null, after: input },
        summary: `Variant created for product ${product_id}.`,
      };
    },
  }, callerHash);
}
