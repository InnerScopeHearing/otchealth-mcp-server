import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProductVariants } from '../../shopify/full-client.js';

export function registerShopifyVariantList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_variant_list',
    category: 'read',
    annotations: {
      title: 'List product variants',
      description: 'Retrieve all variants for a product via GET /products/{id}/variants.json.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      product_id: z.union([z.string(), z.number()]).describe('Shopify product ID.'),
      limit: z.number().int().min(1).max(250).optional().default(250).describe('Max variants to return.'),
      page_info: z.string().optional().describe('Pagination cursor.'),
      fields: z.string().optional().describe('Comma-separated fields to return.'),
    },
    outputShape: {
      variants: z.unknown(),
    },
    handler: async (input, ctx) => {
      const { product_id, ...params } = input;
      const variants = await listProductVariants(product_id, params, { correlationId: ctx.correlationId });
      return { data: { variants }, summary: `Listed variants for product ${product_id}.` };
    },
  }, callerHash);
}
