import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProducts } from '../../stripe/api-client.js';

export function registerStripeListProducts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_list_products',
    category: 'read',
    annotations: {
      title: 'List Stripe products',
      description: 'List products in Stripe catalog.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      active: z.boolean().optional().describe('Filter by active status.'),
    },
    outputShape: {
      products: z.array(z.object({ id: z.string(), name: z.string(), active: z.boolean(), created: z.string() })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listProducts({ limit: input.limit ?? 10, active: input.active });
      const products = (result.data ?? []).map((p: any) => ({
        id: p.id, name: p.name ?? '', active: p.active ?? true,
        created: new Date(p.created * 1000).toISOString(),
      }));
      return {
        data: { products, count: products.length, has_more: result.has_more ?? false },
        summary: `Found ${products.length} product(s).`,
      };
    },
  }, callerHash);
}
