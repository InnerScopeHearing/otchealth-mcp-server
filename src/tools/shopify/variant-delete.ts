import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProductVariant } from '../../shopify/full-client.js';

export function registerShopifyVariantDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_variant_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a product variant',
      description: 'Permanently delete a product variant via DELETE /products/{product_id}/variants/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.union([z.string(), z.number()]).describe('Shopify product ID that owns the variant.'),
      variant_id: z.union([z.string(), z.number()]).describe('Shopify variant ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_variant_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_variant_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete variant ${input.variant_id} from product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteProductVariant(input.product_id, input.variant_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_variant_id: input.variant_id },
        audit: { before: null, after: input },
        summary: `Variant ${input.variant_id} deleted from product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
