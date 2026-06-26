import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { removeProductFromCollection } from '../../shopify/full-client.js';

export function registerShopifyCollectionRemoveProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_collection_remove_product',
    category: 'write_simple',
    annotations: {
      title: 'Remove product from a custom collection',
      description: 'Delete a collect record (removes product from custom collection) via DELETE /collects/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      collect_id: z.union([z.string(), z.number()]).describe('The collect record ID to delete (not the product or collection ID). Get this from shopify_collection_list.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_collect_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_collect_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete collect record ${input.collect_id}. Pass dry_run=false to apply.`,
        };
      }
      await removeProductFromCollection(input.collect_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_collect_id: input.collect_id },
        audit: { before: null, after: input },
        summary: `Collect record ${input.collect_id} deleted.`,
      };
    },
  }, callerHash);
}
