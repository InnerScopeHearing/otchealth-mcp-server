import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { revokeApplePurchase } from '../../revenuecat/full-client.js';

export function registerRevenueCatSubscriptionRevokeApple(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_subscription_revoke_apple',
    category: 'write_orchestrated',
    annotations: {
      title: 'Revoke Apple subscription',
      description: 'Revoke an Apple App Store subscription for a subscriber. Cancels and refunds. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      app_user_id: z.string().describe('App user ID'),
      product_id: z.string().describe('Apple product ID (subscription SKU)'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), result: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would revoke Apple subscription ${input.product_id} for ${input.app_user_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await revokeApplePurchase(input.app_user_id, input.product_id);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: input },
        summary: `Apple subscription ${input.product_id} revoked for ${input.app_user_id}.`,
      };
    },
  }, callerHash);
}
