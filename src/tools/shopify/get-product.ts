import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestGet } from '../../shopify/client.js';

export function registerShopifyGetProduct(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_get_product',
      category: 'read',
      annotations: {
        title: 'Get a Shopify product',
        description:
          'Fetch a single product by id. Includes full body_html, variants with prices, images, options, metafields-link, and timestamps.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        product_id: z.union([z.string(), z.number()]),
        include_body_html: z
          .boolean()
          .optional()
          .describe('If false, omits the (potentially large) body_html field from the response.'),
      },
      outputShape: {
        product: z.unknown(),
        body_html_included: z.boolean(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.product_id));
        const includeBody = input.include_body_html !== false;
        const fields = includeBody
          ? 'id,title,handle,status,body_html,product_type,vendor,created_at,updated_at,published_at,tags,variants,options,images'
          : 'id,title,handle,status,product_type,vendor,created_at,updated_at,published_at,tags,variants,options,images';
        const data = await shopifyRestGet<{ product?: unknown }>(`/products/${id}.json`, {
          query: { fields },
          correlationId: ctx.correlationId,
        });
        return {
          data: { product: data.product ?? null, body_html_included: includeBody },
        };
      },
    },
    callerHash,
  );
}
