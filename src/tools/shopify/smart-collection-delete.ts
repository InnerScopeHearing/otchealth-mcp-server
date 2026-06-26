import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteSmartCollection } from '../../shopify/full-client.js';

export function registerShopifySmartCollectionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_smart_collection_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a smart collection',
      description: 'Permanently delete a smart collection via DELETE /smart_collections/{id}.json. IRREVERSIBLE. Requires acknowledge_warning=true. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify smart collection ID to delete.'),
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
          summary: `DRY RUN: would delete smart collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteSmartCollection(input.collection_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, deleted_collection_id: input.collection_id },
        audit: { before: null, after: input },
        summary: `Smart collection ${input.collection_id} deleted.`,
      };
    },
  }, callerHash);
}
