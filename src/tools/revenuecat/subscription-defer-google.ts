import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deferGooglePurchase } from '../../revenuecat/full-client.js';

export function registerRevenueCatSubscriptionDeferGoogle(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_subscription_defer_google',
    category: 'write_orchestrated',
    annotations: {
      title: 'Defer Google subscription renewal',
      description: 'Defer a Google Play subscription renewal to a future date (e.g. for grace periods or goodwill). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      app_user_id: z.string().describe('App user ID'),
      product_id: z.string().describe('Google Play product ID (subscription SKU)'),
      token: z.string().describe('Google Play purchase token'),
      expiry_time_ms: z.number().int().describe('New expiry time in milliseconds since epoch'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), result: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, result: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would defer Google subscription ${input.product_id} for ${input.app_user_id} to ${new Date(input.expiry_time_ms).toISOString()}. Pass dry_run=false to apply.`,
        };
      }
      const result = await deferGooglePurchase(input.app_user_id, input.product_id, { expiry_time_ms: input.expiry_time_ms, token: input.token });
      return {
        data: { executed: true, dry_run: false, result },
        audit: { before: null, after: input },
        summary: `Google subscription ${input.product_id} deferred to ${new Date(input.expiry_time_ms).toISOString()}.`,
      };
    },
  }, callerHash);
}
