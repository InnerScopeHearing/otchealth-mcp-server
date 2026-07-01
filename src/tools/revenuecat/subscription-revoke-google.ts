import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { revokeGooglePurchase } from '../../revenuecat/full-client.js';

export function registerRevenueCatSubscriptionRevokeGoogle(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_subscription_revoke_google',
    category: 'write_orchestrated',
    annotations: {
      title: 'Revoke Google subscription',
      description: 'Revoke a Google Play subscription for a subscriber. This refunds the most recent payment and cancels. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      app_user_id: z.string().describe('App user ID'),
      product_id: z.string().describe('Google Play product ID (subscription SKU)'),
      token: z.string().describe('Google Play purchase token'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), result: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would revoke Google subscription ${input.product_id} for ${input.app_user_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await revokeGooglePurchase(input.app_user_id, input.product_id, input.token);
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: input },
        summary: `Google subscription ${input.product_id} revoked for ${input.app_user_id}.`,
      };
    },
  }, callerHash);
}
