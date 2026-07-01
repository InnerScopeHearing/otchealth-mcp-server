import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCoupon } from '../../stripe/full-client.js';

export function registerStripeCouponGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_coupon_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe coupon',
      description: 'Retrieve a single coupon by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      coupon_id: z.string().describe('Coupon ID.'),
    },
    outputShape: {
      id: z.string(),
      name: z.string().nullable(),
      duration: z.string(),
      amount_off: z.number().nullable(),
      percent_off: z.number().nullable(),
      currency: z.string().nullable(),
      valid: z.boolean(),
      times_redeemed: z.number(),
    },
    handler: async (input, _ctx) => {
      const c = await getCoupon(input.coupon_id);
      return {
        data: {
          id: c.id,
          name: c.name ?? null,
          duration: c.duration,
          amount_off: c.amount_off ?? null,
          percent_off: c.percent_off ?? null,
          currency: c.currency ?? null,
          valid: c.valid ?? false,
          times_redeemed: c.times_redeemed ?? 0,
        },
        summary: `Coupon ${c.id}: ${c.percent_off ? `${c.percent_off}%` : `${c.currency} ${c.amount_off / 100}`} off, ${c.duration}.`,
      };
    },
  }, callerHash);
}
