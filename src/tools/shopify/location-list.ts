import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listLocations } from '../../shopify/full-client.js';

export function registerShopifyLocationList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_location_list',
    category: 'read',
    annotations: {
      title: 'List Shopify locations',
      description: 'Retrieve all locations (warehouses, stores, fulfillment centers) via GET /locations.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      locations: z.unknown(),
    },
    handler: async (_input, ctx) => {
      const locations = await listLocations({ correlationId: ctx.correlationId });
      return { data: { locations }, summary: `Listed locations.` };
    },
  }, callerHash);
}
