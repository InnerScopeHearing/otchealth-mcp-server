import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProduct } from '../../shopify/full-client.js';

export function registerShopifyProductDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_product_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Shopify product',
      description: 'Permanently delete a product and all its variants via DELETE /products/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.union([z.string(), z.number()]).describe('Shopify product ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_product_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_product_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete product ${input.product_id} and all its variants. Pass dry_run=false to apply.`,
        };
      }
      await deleteProduct(input.product_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_product_id: input.product_id },
        audit: { before: null, after: input },
        summary: `Product ${input.product_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
