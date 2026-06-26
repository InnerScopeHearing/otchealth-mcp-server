import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomCollection } from '../../shopify/full-client.js';

export function registerShopifyCustomCollectionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_custom_collection_get',
    category: 'read',
    annotations: {
      title: 'Get a custom collection',
      description: 'Retrieve a single custom collection by ID via GET /custom_collections/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify custom collection ID.'),
    },
    outputShape: {
      custom_collection: z.unknown(),
    },
    handler: async (input, ctx) => {
      const custom_collection = await getCustomCollection(input.collection_id, { correlationId: ctx.correlationId });
      return { data: { custom_collection }, summary: `Retrieved custom collection ${input.collection_id}.` };
    },
  }, callerHash);
}
