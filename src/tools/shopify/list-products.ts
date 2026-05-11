import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { shopifyRestGet } from '../../shopify/client.js';

interface ProductsResponse {
  products?: Array<{
    id: number;
    title?: string;
    handle?: string;
    status?: string;
    product_type?: string;
    vendor?: string;
    created_at?: string;
    updated_at?: string;
    published_at?: string | null;
    tags?: string;
    variants?: Array<{ id: number; title?: string; price?: string; sku?: string; inventory_quantity?: number }>;
  }>;
}

export function registerShopifyListProducts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'shopify_list_products',
      category: 'read',
      annotations: {
        title: 'List Shopify products',
        description:
          'List products on hearingassist.myshopify.com (storefront otchealthmart.com). Returns id, title, handle, status, vendor, variants with prices, and tags.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        limit: z.number().int().min(1).max(250).optional().describe('Default 50, max 250.'),
        page_info: z.string().optional().describe('Pagination cursor (Shopify Link header).'),
        status: z.enum(['active', 'archived', 'draft']).optional(),
        vendor: z.string().optional(),
        product_type: z.string().optional(),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return. Defaults to a useful subset.'),
      },
      outputShape: {
        products: z.array(z.unknown()),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {
          limit: input.limit ?? 50,
          page_info: input.page_info,
          status: input.status,
          vendor: input.vendor,
          product_type: input.product_type,
          fields:
            input.fields ??
            'id,title,handle,status,product_type,vendor,created_at,updated_at,published_at,tags,variants',
        };
        const data = await shopifyRestGet<ProductsResponse>('/products.json', {
          query,
          correlationId: ctx.correlationId,
        });
        const products = data.products ?? [];
        return {
          data: { products, count: products.length },
          summary: `Found ${products.length} product(s).`,
        };
      },
    },
    callerHash,
  );
}
