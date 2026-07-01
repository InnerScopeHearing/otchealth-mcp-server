import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePromotionCode } from '../../stripe/full-client.js';

export function registerStripePromotionCodeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_promotion_code_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe promotion code',
      description: 'Toggle active state or update metadata on a promotion code. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      promotion_code_id: z.string().describe('Promotion code ID (promo_...) to update.'),
      active: z.boolean().optional().describe('Enable or disable the promotion code.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      promotion_code_id: z.string().nullable(),
      active: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, promotion_code_id: input.promotion_code_id, active: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update promotion code ${input.promotion_code_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await updatePromotionCode(input.promotion_code_id, {
        active: input.active,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, promotion_code_id: upstream.id, active: upstream.active },
        audit: { before: null, after: input },
        summary: `Updated promotion code ${upstream.id} (active: ${upstream.active}).`,
      };
    },
  }, callerHash);
}
