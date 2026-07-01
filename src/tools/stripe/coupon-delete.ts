import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCoupon } from '../../stripe/full-client.js';

export function registerStripeCouponDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_coupon_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Stripe coupon',
      description: 'Delete a coupon. Existing subscriptions using the coupon are unaffected. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      coupon_id: z.string().describe('Coupon ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      coupon_id: z.string().nullable(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, coupon_id: input.coupon_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete coupon ${input.coupon_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteCoupon(input.coupon_id);
      return {
        data: { executed: true, dry_run: false, coupon_id: upstream.id, deleted: upstream.deleted ?? true },
        audit: { before: null, after: input },
        summary: `Deleted coupon ${input.coupon_id}.`,
      };
    },
  }, callerHash);
}
