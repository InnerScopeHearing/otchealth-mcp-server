import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPromotionCode } from '../../stripe/full-client.js';

export function registerStripePromotionCodeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_promotion_code_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe promotion code',
      description: 'Retrieve a single promotion code by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      promotion_code_id: z.string().describe('Promotion code ID (promo_...).'),
    },
    outputShape: {
      id: z.string(),
      code: z.string(),
      active: z.boolean(),
      coupon: z.string(),
      times_redeemed: z.number(),
      max_redemptions: z.number().nullable(),
      expires_at: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const p = await getPromotionCode(input.promotion_code_id);
      return {
        data: {
          id: p.id,
          code: p.code,
          active: p.active,
          coupon: typeof p.coupon === 'string' ? p.coupon : p.coupon?.id,
          times_redeemed: p.times_redeemed ?? 0,
          max_redemptions: p.max_redemptions ?? null,
          expires_at: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : null,
        },
        summary: `Promotion code ${p.code} (${p.id}): ${p.active ? 'active' : 'inactive'}.`,
      };
    },
  }, callerHash);
}
