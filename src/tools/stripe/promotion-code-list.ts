import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPromotionCodes } from '../../stripe/full-client.js';

export function registerStripePromotionCodeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_promotion_code_list',
    category: 'read',
    annotations: {
      title: 'List Stripe promotion codes',
      description: 'List promotion codes, optionally filtered by code string, coupon, or customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      code: z.string().optional().describe('Filter by promotion code string.'),
      active: z.boolean().optional().describe('Filter by active status.'),
      coupon: z.string().optional().describe('Filter by coupon ID.'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      promotion_codes: z.array(z.object({
        id: z.string(),
        code: z.string(),
        active: z.boolean(),
        coupon: z.string(),
        times_redeemed: z.number(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listPromotionCodes({
        limit: input.limit ?? 10,
        code: input.code,
        active: input.active,
        coupon: input.coupon,
        customer: input.customer,
        starting_after: input.starting_after,
      });
      const promotion_codes = (result.data ?? []).map((p: any) => ({
        id: p.id,
        code: p.code,
        active: p.active,
        coupon: typeof p.coupon === 'string' ? p.coupon : p.coupon?.id,
        times_redeemed: p.times_redeemed ?? 0,
      }));
      return {
        data: { promotion_codes, count: promotion_codes.length, has_more: result.has_more ?? false },
        summary: `Found ${promotion_codes.length} promotion code(s).`,
      };
    },
  }, callerHash);
}
