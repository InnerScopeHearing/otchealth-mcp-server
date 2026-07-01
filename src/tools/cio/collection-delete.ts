import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCollection } from '../../customerio/full-client.js';

export function registerCioCollectionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a Customer.io collection',
      description: 'Permanently delete a data collection via App API DELETE /collections/{id}. Irreversible — all collection data is lost and any templates referencing it will break. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.number().int().positive().describe('Numeric ID of the collection to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection_id: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection_id: input.collection_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete collection ${input.collection_id}. Pass dry_run=false to confirm.`,
        };
      }
      await deleteCollection({ collection_id: input.collection_id, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, collection_id: input.collection_id },
        audit: { before: { collection_id: input.collection_id }, after: null },
        summary: `Collection ${input.collection_id} deleted.`,
      };
    },
  }, callerHash);
}
