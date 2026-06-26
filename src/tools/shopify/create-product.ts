import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestWrite } from '../../shopify/client.js';

export function registerShopifyCreateProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_create_product',
      category: 'write_simple',
      annotations: {
        title: 'Shopify: create product',
        description: 'Create a new product on the OTCHealthMart store. Defaults status=draft so nothing goes live by accident. Honors dry_run (plan-only by default).',
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
      inputShape: {
        title: z.string().describe('Product title.'),
        body_html: z.string().optional(),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        tags: z.string().optional(),
        status: z.enum(['active', 'archived', 'draft']).optional().describe('Default draft.'),
        variants: z.array(z.object({ price: z.string(), compare_at_price: z.string().optional(), sku: z.string().optional(), title: z.string().optional() })).optional(),
        images: z.array(z.object({ src: z.string() })).optional(),
      },
      outputShape: { product: z.unknown().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        const product: Record<string, unknown> = { title: input.title, status: input.status ?? 'draft' };
        for (const k of ['body_html', 'vendor', 'product_type', 'tags', 'variants', 'images'] as const) if (input[k] !== undefined) product[k] = input[k];
        if (ctx.dryRun) return { data: { planned: true }, summary: `DRY RUN: would create product "${input.title}" (status=${product.status}). Pass dry_run=false to execute.` };
        const r = await shopifyRestWrite<{ product?: { id?: number } }>('POST', `/products.json`, { product }, { correlationId: ctx.correlationId });
        return { data: { product: r.product }, summary: `Created product "${input.title}" (id ${r.product?.id}, status ${product.status}).`, audit: { after: r.product } };
      },
    },
    callerHash,
  );
}
