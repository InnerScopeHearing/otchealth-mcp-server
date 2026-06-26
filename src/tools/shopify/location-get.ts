import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getLocation } from '../../shopify/full-client.js';

export function registerShopifyLocationGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_location_get',
    category: 'read',
    annotations: {
      title: 'Get a Shopify location',
      description: 'Retrieve a single location by ID via GET /locations/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      location_id: z.union([z.string(), z.number()]).describe('Shopify location ID.'),
    },
    outputShape: {
      location: z.unknown(),
    },
    handler: async (input, ctx) => {
      const location = await getLocation(input.location_id, { correlationId: ctx.correlationId });
      return { data: { location }, summary: `Retrieved location ${input.location_id}.` };
    },
  }, callerHash);
}
