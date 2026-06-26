import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPromotionCode } from '../../stripe/full-client.js';

export function registerStripePromotionCodeCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_promotion_code_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe promotion code',
      description: 'Create a customer-facing promotion code for an existing coupon. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      coupon: z.string().describe('Coupon ID (must exist) to create a code for.'),
      code: z.string().optional().describe('Custom code string (e.g. SAVE20). Auto-generated if omitted.'),
      active: z.boolean().optional().describe('Whether the code is active (default true).'),
      customer: z.string().optional().describe('Restrict to a specific customer ID.'),
      expires_at: z.number().int().optional().describe('Expiry as Unix timestamp.'),
      max_redemptions: z.number().int().min(1).optional().describe('Max redemptions.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      promotion_code_id: z.string().nullable(),
      code: z.string().nullable(),
      active: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, promotion_code_id: null, code: input.code ?? null, active: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create promotion code for coupon ${input.coupon}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createPromotionCode({
        coupon: input.coupon,
        code: input.code,
        active: input.active,
        customer: input.customer,
        expires_at: input.expires_at,
        max_redemptions: input.max_redemptions,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, promotion_code_id: upstream.id, code: upstream.code, active: upstream.active },
        audit: { before: null, after: input },
        summary: `Created promotion code ${upstream.code} (${upstream.id}).`,
      };
    },
  }, callerHash);
}
