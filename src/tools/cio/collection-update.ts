import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCollection } from '../../customerio/full-client.js';

export function registerCioCollectionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a Customer.io collection',
      description: 'Update name or data for an existing collection via App API PUT /collections/{id}. Replaces all rows when data is provided. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.number().int().positive().describe('Numeric ID of the collection to update.'),
      name: z.string().min(1).optional().describe('New name for the collection.'),
      data: z.array(z.record(z.unknown())).optional().describe('Replacement rows for the collection (replaces ALL existing rows).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      const collection = await updateCollection({ ...input, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, collection },
        audit: { before: null, after: input },
        summary: `Collection ${input.collection_id} updated.`,
      };
    },
  }, callerHash);
}
