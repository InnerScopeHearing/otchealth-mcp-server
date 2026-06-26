import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSale } from '../../gumroad/full-client.js';

export function registerGumroadSaleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_sale_get',
    category: 'read',
    annotations: {
      title: 'Get single Gumroad sale',
      description: 'Retrieve full details for a specific Gumroad sale by ID, including buyer info, amount, and fulfillment status.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      sale_id: z.string().describe('Gumroad sale ID.'),
    },
    outputShape: {
      sale: z.record(z.unknown()),
    },
    handler: async (input, _ctx) => {
      const resp = await getSale(input.sale_id);
      const sale = resp.sale ?? resp;
      return {
        data: { sale },
        summary: `Sale ${input.sale_id}: ${sale.email ?? 'unknown buyer'}, $${(sale.price ?? 0) / 100} (${sale.refunded ? 'refunded' : 'not refunded'}).`,
      };
    },
  }, callerHash);
}
