import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addProductToCollection } from '../../shopify/full-client.js';

export function registerShopifyCollectionAddProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_collection_add_product',
    category: 'write_simple',
    annotations: {
      title: 'Add product to a custom collection',
      description: 'Create a collect record to add a product to a custom collection via POST /collects.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.union([z.string(), z.number()]).describe('Shopify product ID to add.'),
      collection_id: z.union([z.string(), z.number()]).describe('Shopify custom collection ID to add the product to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collect: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collect: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add product ${input.product_id} to collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      const collect = await addProductToCollection(input.product_id, input.collection_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, collect },
        audit: { before: null, after: input },
        summary: `Product ${input.product_id} added to collection ${input.collection_id}.`,
      };
    },
  }, callerHash);
}
