import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProduct } from '../../shopify/write-client.js';

const variantSchema = z.object({
  price: z.string().optional().describe('Variant price, e.g. "29.99".'),
  sku: z.string().optional().describe('Stock-keeping unit.'),
  barcode: z.string().optional(),
  inventory_management: z
    .enum(['shopify', 'not_managed'])
    .optional()
    .describe('"shopify" to track inventory; omit or "not_managed" to disable tracking.'),
  inventory_policy: z
    .enum(['deny', 'continue'])
    .optional()
    .describe('Whether to allow purchase when out of stock.'),
  taxable: z.boolean().optional(),
  weight: z.number().optional(),
  weight_unit: z.enum(['g', 'kg', 'oz', 'lb']).optional(),
  requires_shipping: z.boolean().optional(),
  option1: z.string().optional().describe('First option value, e.g. "Small".'),
  option2: z.string().optional(),
  option3: z.string().optional(),
  compare_at_price: z
    .string()
    .nullable()
    .optional()
    .describe('Compare-at ("was") price, or null to clear.'),
});

export function registerShopifyCreateProduct(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_create_product',
      category: 'write_simple',
      annotations: {
        title: 'Create a Shopify product',
        description:
          'Create a new product on hearingassist.myshopify.com (otchealthmart.com) via POST /products.json. ' +
          'Supports title, description, vendor, type, tags, status, variants, and options. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        title: z.string().min(1).describe('Product title (required).'),
        body_html: z.string().optional().describe('Product description as HTML.'),
        vendor: z.string().optional().describe('Vendor / brand name.'),
        product_type: z.string().optional().describe('Custom product type label.'),
        tags: z
          .string()
          .optional()
          .describe('Comma-separated tag string, e.g. "hearing-aid,otc,featured".'),
        status: z
          .enum(['active', 'archived', 'draft'])
          .optional()
          .default('draft')
          .describe('Product status. Defaults to "draft" so it is not immediately live.'),
        handle: z.string().optional().describe('URL handle (slug). Auto-generated if omitted.'),
        published: z
          .boolean()
          .optional()
          .describe('Whether the product is published to the online store channel.'),
        variants: z
          .array(variantSchema)
          .optional()
          .describe(
            'List of variants. Omit to create a single default variant. ' +
              'If omitted, set price at top level via variants[0].price.',
          ),
        options: z
          .array(z.object({ name: z.string() }))
          .optional()
          .describe('Option names, e.g. [{"name":"Size"},{"name":"Color"}].'),
        images: z
          .array(z.object({ src: z.string().url(), alt: z.string().optional() }))
          .optional()
          .describe('Image URLs to attach.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        product: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, product: null },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create product "${input.title}" with status "${input.status ?? 'draft'}". Pass dry_run=false to apply.`,
          };
        }
        const product = await createProduct(
          {
            title: input.title,
            body_html: input.body_html,
            vendor: input.vendor,
            product_type: input.product_type,
            tags: input.tags,
            status: input.status,
            handle: input.handle,
            published: input.published,
            variants: input.variants as never,
            options: input.options,
            images: input.images,
          },
          { correlationId: ctx.correlationId },
        );
        return {
          data: { executed: true, dry_run: false, product },
          audit: { before: null, after: input },
          summary: `Product "${input.title}" created.`,
        };
      },
    },
    callerHash,
  );
}
