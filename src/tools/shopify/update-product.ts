import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProduct } from '../../shopify/write-client.js';

const variantPatchSchema = z.object({
  id: z.number().int().describe('Variant ID (required to update an existing variant).'),
  price: z.string().optional().describe('New price string, e.g. "39.99".'),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  compare_at_price: z.string().nullable().optional(),
  inventory_policy: z.enum(['deny', 'continue']).optional(),
  taxable: z.boolean().optional(),
  weight: z.number().optional(),
  weight_unit: z.enum(['g', 'kg', 'oz', 'lb']).optional(),
  requires_shipping: z.boolean().optional(),
});

export function registerShopifyUpdateProduct(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_update_product',
      category: 'write_simple',
      annotations: {
        title: 'Update a Shopify product',
        description:
          'Update an existing product via PUT /products/{id}.json. Patch any subset of: title, body_html, ' +
          'vendor, product_type, tags, status, handle, published, and variant prices/SKUs. ' +
          'Include variant id to update a specific variant. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        product_id: z
          .union([z.string(), z.number()])
          .describe('Shopify product ID (numeric or string).'),
        title: z.string().optional(),
        body_html: z.string().optional().describe('Product description as HTML.'),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        tags: z
          .string()
          .optional()
          .describe(
            'Comma-separated full tag string. Replaces the existing tag list entirely.',
          ),
        status: z.enum(['active', 'archived', 'draft']).optional(),
        handle: z.string().optional().describe('URL handle (slug).'),
        published: z
          .boolean()
          .optional()
          .describe('Set true to publish, false to unpublish from storefront.'),
        variants: z
          .array(variantPatchSchema)
          .optional()
          .describe(
            'Variant patches. Each entry MUST include the variant id. ' +
              'Only supplied fields are changed.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        product: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const { product_id, ...patch } = input;

        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, product: null },
            audit: { before: null, after: input },
            summary: `DRY RUN: would update product ${product_id} with fields: ${Object.keys(patch).join(', ')}. Pass dry_run=false to apply.`,
          };
        }

        const product = await updateProduct(
          product_id,
          patch as never,
          { correlationId: ctx.correlationId },
        );
        return {
          data: { executed: true, dry_run: false, product },
          audit: { before: null, after: input },
          summary: `Product ${product_id} updated.`,
        };
      },
    },
    callerHash,
  );
}
