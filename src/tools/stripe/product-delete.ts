import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProduct } from '../../stripe/full-client.js';

export function registerStripeProductDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_product_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Stripe product',
      description: 'Delete a product. Cannot delete if it has active prices. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Product ID (prod_...) to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      product_id: z.string().nullable(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, product_id: input.product_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete product ${input.product_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteProduct(input.product_id);
      return {
        data: { executed: true, dry_run: false, product_id: upstream.id, deleted: upstream.deleted ?? true },
        audit: { before: null, after: input },
        summary: `Deleted product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
