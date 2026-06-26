import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCollectionContent } from '../../customerio/full-client.js';

export function registerCioCollectionUpdateContent(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_update_content',
    category: 'write_simple',
    annotations: {
      title: 'Replace Customer.io collection content',
      description: 'Replace all row data in a collection via App API PUT /collections/{id}/content. This is a full replacement — all existing rows are overwritten. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.number().int().positive().describe('Numeric ID of the collection to update content for.'),
      data: z.array(z.record(z.unknown())).describe('New rows for the collection (REPLACES all existing rows). Each element is a key-value record.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      collection_id: z.number(),
      rows_count: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, collection_id: input.collection_id, rows_count: input.data.length },
          audit: { before: null, after: input },
          summary: `DRY RUN: would replace all content in collection ${input.collection_id} with ${input.data.length} row(s). Pass dry_run=false to apply.`,
        };
      }
      await updateCollectionContent({ collection_id: input.collection_id, data: input.data, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, collection_id: input.collection_id, rows_count: input.data.length },
        audit: { before: null, after: input },
        summary: `Collection ${input.collection_id} content replaced with ${input.data.length} row(s).`,
      };
    },
  }, callerHash);
}
