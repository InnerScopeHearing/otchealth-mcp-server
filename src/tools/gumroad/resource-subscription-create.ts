import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createResourceSubscription } from '../../gumroad/full-client.js';

export function registerGumroadResourceSubscriptionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_resource_subscription_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Gumroad webhook subscription',
      description: 'Register a webhook URL to receive Gumroad event notifications (e.g. new sales, refunds). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      resource_name: z.enum([
        'sale', 'refund', 'dispute', 'dispute_won',
        'cancellation', 'subscription_updated', 'subscription_ended', 'subscription_restarted',
      ]).describe('Gumroad event type to subscribe to.'),
      post_url: z.string().url().describe('HTTPS URL that Gumroad will POST event payloads to.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      resource_subscription: z.record(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would register webhook for "${input.resource_name}" events → ${input.post_url}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createResourceSubscription(input.resource_name, input.post_url);
      return {
        data: { executed: true, dry_run: false, resource_subscription: resp.resource_subscription ?? resp },
        audit: { before: null, after: input },
        summary: `Registered webhook for "${input.resource_name}" → ${input.post_url}.`,
      };
    },
  }, callerHash);
}
