import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMetafields } from '../../shopify/full-client.js';

export function registerShopifyMetafieldList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_metafield_list',
    category: 'read',
    annotations: {
      title: 'List metafields',
      description: 'Retrieve metafields for a resource via GET /metafields.json. Filter by owner_resource (product, order, customer, etc.) and owner_id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner_resource: z.enum(['product', 'variant', 'image', 'customer', 'collection', 'order', 'draft_order', 'blog', 'article', 'page', 'shop']).optional().describe('The resource type owning the metafields.'),
      owner_id: z.union([z.string(), z.number()]).optional().describe('The ID of the owning resource. Required when owner_resource is provided.'),
      namespace: z.string().optional().describe('Filter by metafield namespace.'),
      key: z.string().optional().describe('Filter by metafield key.'),
      limit: z.number().int().min(1).max(250).optional().default(50).describe('Max results.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      metafields: z.unknown(),
    },
    handler: async (input, ctx) => {
      const metafields = await listMetafields(input as any, { correlationId: ctx.correlationId });
      return { data: { metafields }, summary: `Listed metafields.` };
    },
  }, callerHash);
}
