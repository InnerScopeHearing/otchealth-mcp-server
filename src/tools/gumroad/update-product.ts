import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProduct } from '../../gumroad/write-client.js';

export function registerGumroadUpdateProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_update_product',
    category: 'write_simple',
    annotations: {
      title: 'Update a Gumroad product',
      description: 'Update name, price (in cents), description, or permalink of a Gumroad product via PUT /v2/products/{id}. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product id (from gumroad_list_products).'),
      name: z.string().optional().describe('New product name.'),
      price: z.number().int().min(0).optional().describe('New price in cents (USD). E.g. 999 = $9.99.'),
      description: z.string().optional().describe('New product description (HTML or plain text).'),
      url: z.string().optional().describe('New custom permalink slug (alphanumeric, hyphens).'),
      customizable_price: z.boolean().optional().describe('Enable pay-what-you-want pricing.'),
      suggested_price: z.number().int().min(0).optional().describe('Suggested price for pay-what-you-want (in cents).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      product_id: z.string(),
      name: z.string().nullable(),
      price_cents: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product_id: input.product_id, name: input.name ?? null, price_cents: input.price ?? null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await updateProduct({
        product_id: input.product_id,
        name: input.name,
        price: input.price,
        description: input.description,
        url: input.url,
        customizable_price: input.customizable_price,
        suggested_price: input.suggested_price,
      });
      const product = resp.product ?? resp;
      return {
        data: {
          executed: true,
          dry_run: false,
          product_id: product.id ?? input.product_id,
          name: product.name ?? null,
          price_cents: typeof product.price === 'number' ? product.price : null,
        },
        audit: { before: null, after: input },
        summary: `Product ${product.id ?? input.product_id} updated${product.name ? ` — "${product.name}"` : ''}.`,
      };
    },
  }, callerHash);
}
