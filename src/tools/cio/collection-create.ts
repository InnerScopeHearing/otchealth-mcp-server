import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCollection } from '../../customerio/full-client.js';

export function registerCioCollectionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Customer.io collection',
      description: 'Create a new data collection in the workspace via App API POST /collections. Collections store structured datasets (product catalogs, lookup tables) for use in Liquid templates. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().min(1).describe('Name for the new collection. Must be unique in the workspace.'),
      data: z.array(z.record(z.unknown())).describe('Initial rows for the collection. Each element is a record (key-value object).'),
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
          summary: `DRY RUN: would create collection "${input.name}" with ${input.data.length} row(s). Pass dry_run=false to apply.`,
        };
      }
      const collection = await createCollection({ name: input.name, data: input.data, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, collection },
        audit: { before: null, after: input },
        summary: `Collection "${input.name}" created.`,
      };
    },
  }, callerHash);
}
