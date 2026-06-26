import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProduct } from '../../stripe/full-client.js';

export function registerStripeProductGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_product_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe product',
      description: 'Retrieve a single product by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Product ID (prod_...).'),
    },
    outputShape: {
      id: z.string(),
      name: z.string(),
      active: z.boolean(),
      description: z.string().nullable(),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const p = await getProduct(input.product_id);
      return {
        data: {
          id: p.id,
          name: p.name,
          active: p.active,
          description: p.description ?? null,
          created: new Date(p.created * 1000).toISOString(),
        },
        summary: `Product ${p.id}: ${p.name} (${p.active ? 'active' : 'inactive'}).`,
      };
    },
  }, callerHash);
}
