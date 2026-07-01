import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSmartCollection } from '../../shopify/full-client.js';

export function registerShopifySmartCollectionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_smart_collection_get',
    category: 'read',
    annotations: {
      title: 'Get a smart collection',
      description: 'Retrieve a single smart (automated) collection by ID via GET /smart_collections/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify smart collection ID.'),
    },
    outputShape: {
      smart_collection: z.unknown(),
    },
    handler: async (input, ctx) => {
      const smart_collection = await getSmartCollection(input.collection_id, { correlationId: ctx.correlationId });
      return { data: { smart_collection }, summary: `Retrieved smart collection ${input.collection_id}.` };
    },
  }, callerHash);
}
