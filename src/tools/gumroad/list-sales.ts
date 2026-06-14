import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSales } from '../../gumroad/api-client.js';

export function registerGumroadListSales(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_list_sales',
    category: 'read',
    annotations: {
      title: 'List Gumroad sales',
      description: 'List Gumroad sales in a date window (product, price, date). Use for the digital-products cash lane: how many SOP units sold and revenue in a period. Buyer email is omitted from the structured output by default.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      after: z.string().optional().describe('Only sales after this date (YYYY-MM-DD).'),
      before: z.string().optional().describe('Only sales before this date (YYYY-MM-DD).'),
      page_key: z.string().optional().describe('Pagination key from a prior response (next_page_key).'),
    },
    outputShape: {
      sales: z.array(z.object({
        id: z.string(),
        product_name: z.string(),
        price: z.number(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
      total_usd: z.number(),
      next_page_key: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await listSales(input);
      // Categorical/financial only. Do NOT surface buyer email/name/address in structured output.
      const mapped = (resp.sales ?? []).map((s: any) => ({
        id: s.id,
        product_name: s.product_name ?? '',
        price: typeof s.price === 'number' ? s.price / 100 : 0,
        created_at: s.created_at ?? null,
      }));
      const total = mapped.reduce((acc: number, s: any) => acc + s.price, 0);
      return {
        data: {
          sales: mapped,
          count: mapped.length,
          total_usd: Number(total.toFixed(2)),
          next_page_key: resp.next_page_key ?? null,
        },
        summary: `${mapped.length} sale(s), $${total.toFixed(2)} in this window${resp.next_page_key ? ' (more pages available)' : ''}.`,
      };
    },
  }, callerHash);
}
