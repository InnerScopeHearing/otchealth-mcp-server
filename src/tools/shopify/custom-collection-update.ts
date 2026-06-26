import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCustomCollection } from '../../shopify/full-client.js';

export function registerShopifyCustomCollectionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_custom_collection_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a custom collection',
      description: 'Update fields on an existing custom collection via PUT /custom_collections/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify custom collection ID to update.'),
      title: z.string().optional().describe('New collection title.'),
      body_html: z.string().optional().describe('Collection description as HTML.'),
      sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional().describe('Default sort order.'),
      published: z.boolean().optional().describe('Whether the collection is published.'),
      handle: z.string().optional().describe('URL handle (slug).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      custom_collection: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, custom_collection: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update custom collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      const { collection_id, ...patch } = input;
      const custom_collection = await updateCustomCollection(collection_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, custom_collection },
        audit: { before: null, after: input },
        summary: `Custom collection ${collection_id} updated.`,
      };
    },
  }, callerHash);
}
