import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProduct } from '../../gumroad/full-client.js';

export function registerGumroadProductGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_product_get',
    category: 'read',
    annotations: {
      title: 'Get single Gumroad product',
      description: 'Retrieve full details for a single Gumroad product by ID, including variants, custom fields, and pricing.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID (from list_products).'),
    },
    outputShape: {
      product: z.record(z.unknown()),
    },
    handler: async (input, _ctx) => {
      const resp = await getProduct(input.product_id);
      const p = resp.product ?? resp;
      return {
        data: { product: p },
        summary: `Product: ${p.name ?? input.product_id} (published=${p.published}).`,
      };
    },
  }, callerHash);
}
