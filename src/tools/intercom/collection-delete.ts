import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDeleteCollection } from '../../intercom/full-client.js';

export function registerIntercomCollectionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_collection_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete an Intercom help center collection (irreversible)',
      description: 'Permanently delete a help center collection via DELETE /help_center/collections/:id. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.string().describe('Intercom collection ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection_id: z.string(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection_id: input.collection_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDeleteCollection(input.collection_id);
      return {
        data: { executed: true, dry_run: false, collection_id: input.collection_id, deleted: true },
        audit: { before: null, after: input },
        summary: `Collection ${input.collection_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
