import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomCollections } from '../../shopify/full-client.js';

export function registerShopifyCustomCollectionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_custom_collection_list',
    category: 'read',
    annotations: {
      title: 'List custom collections',
      description: 'Retrieve manually curated collections via GET /custom_collections.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      title: z.string().optional().describe('Filter by collection title.'),
      product_id: z.union([z.string(), z.number()]).optional().describe('Filter collections containing this product.'),
      published_status: z.enum(['published', 'unpublished', 'any']).optional().describe('Publication status filter.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      custom_collections: z.unknown(),
    },
    handler: async (input, ctx) => {
      const custom_collections = await listCustomCollections(input as any, { correlationId: ctx.correlationId });
      return { data: { custom_collections }, summary: `Listed custom collections.` };
    },
  }, callerHash);
}
