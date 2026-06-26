import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMetafield } from '../../shopify/full-client.js';

export function registerShopifyMetafieldGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_metafield_get',
    category: 'read',
    annotations: {
      title: 'Get a metafield',
      description: 'Retrieve a single metafield by ID via GET /metafields/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      metafield_id: z.union([z.string(), z.number()]).describe('Shopify metafield ID.'),
    },
    outputShape: {
      metafield: z.unknown(),
    },
    handler: async (input, ctx) => {
      const metafield = await getMetafield(input.metafield_id, { correlationId: ctx.correlationId });
      return { data: { metafield }, summary: `Retrieved metafield ${input.metafield_id}.` };
    },
  }, callerHash);
}
