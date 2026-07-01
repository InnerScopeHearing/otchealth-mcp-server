import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCoupon } from '../../stripe/full-client.js';

export function registerStripeCouponUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_coupon_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe coupon',
      description: 'Update name or metadata on an existing coupon. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      coupon_id: z.string().describe('Coupon ID to update.'),
      name: z.string().optional().describe('New display name.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      coupon_id: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, coupon_id: input.coupon_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update coupon ${input.coupon_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updateCoupon(input.coupon_id, { name: input.name, metadata: input.metadata });
      return {
        data: { executed: true, dry_run: false, coupon_id: upstream.id },
        audit: { before: null, after: input },
        summary: `Updated coupon ${upstream.id}.`,
      };
    },
  }, callerHash);
}
