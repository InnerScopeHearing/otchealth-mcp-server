import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateCollection } from '../../intercom/full-client.js';

export function registerIntercomCollectionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_collection_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom help center collection',
      description: 'Update a help center collection\'s name or description via PUT /help_center/collections/:id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.string().describe('Intercom collection ID to update.'),
      name: z.string().optional().describe('New collection name.'),
      description: z.string().optional().describe('New collection description.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection_id: input.collection_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateCollection(input);
      return {
        data: { executed: true, dry_run: false, collection_id: input.collection_id },
        audit: { before: null, after: input },
        summary: `Collection ${input.collection_id} updated.`,
      };
    },
  }, callerHash);
}
