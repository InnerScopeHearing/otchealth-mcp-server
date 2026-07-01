import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelSetupIntent } from '../../stripe/full-client.js';

export function registerStripeSetupIntentCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_setup_intent_cancel',
    category: 'write_simple',
    annotations: {
      title: 'Cancel Stripe setup intent',
      description: 'Cancel a setup intent. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      setup_intent_id: z.string().describe('Setup intent ID (seti_...) to cancel.'),
      cancellation_reason: z.enum(['abandoned', 'requested_by_customer', 'duplicate']).optional(),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      setup_intent_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, setup_intent_id: input.setup_intent_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel setup intent ${input.setup_intent_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await cancelSetupIntent(input.setup_intent_id, input.cancellation_reason);
      return {
        data: { executed: true, dry_run: false, setup_intent_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Cancelled setup intent ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
