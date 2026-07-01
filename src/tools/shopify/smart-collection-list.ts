import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSmartCollections } from '../../shopify/full-client.js';

export function registerShopifySmartCollectionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_smart_collection_list',
    category: 'read',
    annotations: {
      title: 'List smart collections',
      description: 'Retrieve rule-based (automated) collections via GET /smart_collections.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      title: z.string().optional().describe('Filter by collection title.'),
      product_id: z.union([z.string(), z.number()]).optional().describe('Filter by product ID.'),
      published_status: z.enum(['published', 'unpublished', 'any']).optional().describe('Publication status filter.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      smart_collections: z.unknown(),
    },
    handler: async (input, ctx) => {
      const smart_collections = await listSmartCollections(input as any, { correlationId: ctx.correlationId });
      return { data: { smart_collections }, summary: `Listed smart collections.` };
    },
  }, callerHash);
}
