import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProducts } from '../../gumroad/api-client.js';

export function registerGumroadListProducts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_list_products',
    category: 'read',
    annotations: {
      title: 'List Gumroad products',
      description: 'List Gumroad products (name, price, published state, lifetime sales count and revenue). Use for the digital-products cash lane scoreboard.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      products: z.array(z.object({
        id: z.string(),
        name: z.string(),
        price: z.number(),
        formatted_price: z.string().nullable(),
        published: z.boolean(),
        sales_count: z.number(),
        sales_usd: z.number(),
        url: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await listProducts();
      const mapped = (resp.products ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        price: typeof p.price === 'number' ? p.price / 100 : 0,
        formatted_price: p.formatted_price ?? null,
        published: p.published ?? false,
        sales_count: p.sales_count ?? 0,
        sales_usd: typeof p.sales_usd_cents === 'number' ? p.sales_usd_cents / 100 : 0,
        url: p.short_url ?? p.preview_url ?? null,
      }));
      const totalRevenue = mapped.reduce((acc: number, p: any) => acc + p.sales_usd, 0);
      return {
        data: { products: mapped, count: mapped.length },
        summary: `${mapped.length} product(s), ${mapped.filter((p: any) => p.published).length} published, $${totalRevenue.toFixed(2)} lifetime revenue.`,
      };
    },
  }, callerHash);
}
