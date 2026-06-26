import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { disableProduct } from '../../gumroad/write-client.js';

export function registerGumroadDisableProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_disable_product',
    category: 'write_simple',
    annotations: {
      title: 'Disable (unpublish) a Gumroad product',
      description: 'Take a Gumroad product off-sale (unpublish without deleting) via PUT /v2/products/{id}/disable. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product id (from gumroad_list_products).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      product_id: z.string(),
      published: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product_id: input.product_id, published: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would disable product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await disableProduct(input.product_id);
      const product = resp.product ?? resp;
      return {
        data: {
          executed: true,
          dry_run: false,
          product_id: product.id ?? input.product_id,
          published: product.published ?? false,
        },
        audit: { before: null, after: input },
        summary: `Product ${product.id ?? input.product_id} disabled (published: ${product.published ?? false}).`,
      };
    },
  }, callerHash);
}
