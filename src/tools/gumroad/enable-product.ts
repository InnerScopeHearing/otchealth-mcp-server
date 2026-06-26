import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { enableProduct } from '../../gumroad/write-client.js';

export function registerGumroadEnableProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_enable_product',
    category: 'write_simple',
    annotations: {
      title: 'Enable (publish) a Gumroad product',
      description: 'Make a Gumroad product publicly purchasable via PUT /v2/products/{id}/enable. Defaults to dry_run.',
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
          summary: `DRY RUN: would enable product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await enableProduct(input.product_id);
      const product = resp.product ?? resp;
      return {
        data: {
          executed: true,
          dry_run: false,
          product_id: product.id ?? input.product_id,
          published: product.published ?? true,
        },
        audit: { before: null, after: input },
        summary: `Product ${product.id ?? input.product_id} enabled (published: ${product.published ?? true}).`,
      };
    },
  }, callerHash);
}
