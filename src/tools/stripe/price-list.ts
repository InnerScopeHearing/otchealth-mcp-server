import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPrices } from '../../stripe/full-client.js';

export function registerStripePriceList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_price_list',
    category: 'read',
    annotations: {
      title: 'List Stripe prices',
      description: 'List prices, optionally filtered by product, active status, or currency.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      product: z.string().optional().describe('Filter by product ID.'),
      active: z.boolean().optional().describe('Filter by active status.'),
      currency: z.string().length(3).optional().describe('Filter by currency.'),
      type: z.enum(['one_time', 'recurring']).optional().describe('Filter by price type.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      prices: z.array(z.object({
        id: z.string(),
        product: z.string(),
        currency: z.string(),
        unit_amount: z.number().nullable(),
        type: z.string(),
        active: z.boolean(),
        nickname: z.string().nullable(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listPrices({
        limit: input.limit ?? 10,
        product: input.product,
        active: input.active,
        currency: input.currency,
        type: input.type,
        starting_after: input.starting_after,
      });
      const prices = (result.data ?? []).map((p: any) => ({
        id: p.id,
        product: typeof p.product === 'string' ? p.product : p.product?.id,
        currency: p.currency,
        unit_amount: p.unit_amount ?? null,
        type: p.type,
        active: p.active,
        nickname: p.nickname ?? null,
      }));
      return {
        data: { prices, count: prices.length, has_more: result.has_more ?? false },
        summary: `Found ${prices.length} price(s).`,
      };
    },
  }, callerHash);
}
