import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCollections } from '../../shopify/full-client.js';

export function registerShopifyCollectionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_collection_list',
    category: 'read',
    annotations: {
      title: 'List collection memberships (collects)',
      description: 'Retrieve collect records (product-to-collection memberships) via GET /collects.json. Optionally filter by product_id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max records to return.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      product_id: z.union([z.string(), z.number()]).optional().describe('Filter by product ID.'),
    },
    outputShape: {
      collects: z.unknown(),
    },
    handler: async (input, ctx) => {
      const collects = await listCollections(input as any, { correlationId: ctx.correlationId });
      return { data: { collects }, summary: `Listed collection memberships.` };
    },
  }, callerHash);
}
