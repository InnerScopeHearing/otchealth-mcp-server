import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomCollection } from '../../shopify/full-client.js';

export function registerShopifyCustomCollectionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_custom_collection_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a custom collection',
      description: 'Create a manually curated product collection via POST /custom_collections.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      title: z.string().min(1).describe('Collection title (required).'),
      body_html: z.string().optional().describe('Collection description as HTML.'),
      sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional().describe('Default sort order for products.'),
      published: z.boolean().optional().default(false).describe('Whether to publish immediately (default false).'),
      handle: z.string().optional().describe('URL handle (slug). Auto-generated if omitted.'),
      image_src: z.string().url().optional().describe('Image URL for the collection.'),
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
          summary: `DRY RUN: would create custom collection "${input.title}". Pass dry_run=false to apply.`,
        };
      }
      const { image_src, ...rest } = input;
      const custom_collection = await createCustomCollection(
        { ...rest, ...(image_src ? { image: { src: image_src } } : {}) },
        { correlationId: ctx.correlationId },
      );
      return {
        data: { executed: true, dry_run: false, custom_collection },
        audit: { before: null, after: input },
        summary: `Custom collection "${input.title}" created.`,
      };
    },
  }, callerHash);
}
