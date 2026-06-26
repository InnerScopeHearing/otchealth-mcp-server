import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestWrite } from '../../shopify/client.js';

export function registerShopifyUpdateProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_update_product',
      category: 'write_simple',
      annotations: {
        title: 'Shopify: update product',
        description: 'Update a product on the OTCHealthMart store (title, status, body_html, tags, vendor, product_type, and per-variant price/compare_at_price/sku). Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: {
        product_id: z.union([z.string(), z.number()]).describe('Shopify product id.'),
        title: z.string().optional(),
        status: z.enum(['active', 'archived', 'draft']).optional(),
        body_html: z.string().optional(),
        tags: z.string().optional(),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        variants: z.array(z.object({ id: z.union([z.string(), z.number()]), price: z.string().optional(), compare_at_price: z.string().optional(), sku: z.string().optional() })).optional(),
      },
      outputShape: { product: z.unknown().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        const product: Record<string, unknown> = { id: input.product_id };
        for (const k of ['title', 'status', 'body_html', 'tags', 'vendor', 'product_type'] as const) if (input[k] !== undefined) product[k] = input[k];
        if (input.variants) product.variants = input.variants;
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would update product ${input.product_id} (${Object.keys(product).filter(k => k !== 'id').join(', ')}). Pass dry_run=false to execute.` };
        const r = await shopifyRestWrite<{ product?: unknown }>('PUT', `/products/${input.product_id}.json`, { product }, { correlationId: ctx.correlationId });
        return { data: { product: r.product }, summary: `Updated product ${input.product_id}.`, audit: { after: r.product } };
      },
    },
    callerHash,
  );
}
