import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProductVariant } from '../../shopify/full-client.js';

export function registerShopifyVariantGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_variant_get',
    category: 'read',
    annotations: {
      title: 'Get a product variant',
      description: 'Retrieve a single variant by its ID via GET /variants/{id}.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      variant_id: z.union([z.string(), z.number()]).describe('Shopify variant ID.'),
    },
    outputShape: {
      variant: z.unknown(),
    },
    handler: async (input, ctx) => {
      const variant = await getProductVariant(input.variant_id, { correlationId: ctx.correlationId });
      return { data: { variant }, summary: `Retrieved variant ${input.variant_id}.` };
    },
  }, callerHash);
}
