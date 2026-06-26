import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCoupon } from '../../stripe/full-client.js';

export function registerStripeCouponCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_coupon_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe coupon',
      description: 'Create a new discount coupon. Use either amount_off+currency or percent_off. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      duration: z.enum(['forever', 'once', 'repeating']).describe('How long the discount applies.'),
      amount_off: z.number().int().min(1).optional().describe('Fixed amount off in cents. Requires currency.'),
      percent_off: z.number().min(0.01).max(100).optional().describe('Percentage off (0.01–100).'),
      currency: z.string().length(3).optional().describe('ISO currency code, required if amount_off is set.'),
      duration_in_months: z.number().int().min(1).optional().describe('Required if duration=repeating.'),
      id: z.string().optional().describe('Custom coupon ID. Auto-generated if omitted.'),
      name: z.string().optional().describe('Display name shown to customers.'),
      max_redemptions: z.number().int().min(1).optional().describe('Max number of redemptions.'),
      redeem_by: z.number().int().optional().describe('Expiry as Unix timestamp.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      coupon_id: z.string().nullable(),
      valid: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, coupon_id: null, valid: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create coupon (${input.duration}). Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createCoupon({
        duration: input.duration,
        amount_off: input.amount_off,
        percent_off: input.percent_off,
        currency: input.currency,
        duration_in_months: input.duration_in_months,
        id: input.id,
        name: input.name,
        max_redemptions: input.max_redemptions,
        redeem_by: input.redeem_by,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, coupon_id: upstream.id, valid: upstream.valid ?? null },
        audit: { before: null, after: input },
        summary: `Created coupon ${upstream.id}.`,
      };
    },
  }, callerHash);
}
