import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomCollection } from '../../shopify/full-client.js';

export function registerShopifyCustomCollectionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_custom_collection_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a custom collection',
      description: 'Permanently delete a custom collection via DELETE /custom_collections/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify custom collection ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_collection_id: z.union([z.string(), z.number()]).nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_collection_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete custom collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteCustomCollection(input.collection_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_collection_id: input.collection_id },
        audit: { before: null, after: input },
        summary: `Custom collection ${input.collection_id} deleted.`,
      };
    },
  }, callerHash);
}
