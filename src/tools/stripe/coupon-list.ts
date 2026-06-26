import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCoupons } from '../../stripe/full-client.js';

export function registerStripeCouponList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_coupon_list',
    category: 'read',
    annotations: {
      title: 'List Stripe coupons',
      description: 'List all coupons in the Stripe account.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      coupons: z.array(z.object({
        id: z.string(),
        name: z.string().nullable(),
        duration: z.string(),
        amount_off: z.number().nullable(),
        percent_off: z.number().nullable(),
        valid: z.boolean(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCoupons({ limit: input.limit ?? 10, starting_after: input.starting_after });
      const coupons = (result.data ?? []).map((c: any) => ({
        id: c.id,
        name: c.name ?? null,
        duration: c.duration,
        amount_off: c.amount_off ?? null,
        percent_off: c.percent_off ?? null,
        valid: c.valid ?? false,
      }));
      return {
        data: { coupons, count: coupons.length, has_more: result.has_more ?? false },
        summary: `Found ${coupons.length} coupon(s).`,
      };
    },
  }, callerHash);
}
