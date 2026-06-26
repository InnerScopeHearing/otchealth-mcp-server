import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteResourceSubscription } from '../../gumroad/full-client.js';

export function registerGumroadResourceSubscriptionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_resource_subscription_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Gumroad webhook subscription',
      description: 'Remove a webhook (resource subscription) from the account. Gumroad will stop POSTing events to that URL. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      resource_subscription_id: z.string().describe('Resource subscription ID to delete (from resource_subscription_list).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      success: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete webhook subscription ${input.resource_subscription_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await deleteResourceSubscription(input.resource_subscription_id);
      return {
        data: { executed: true, dry_run: false, success: resp.success },
        audit: { before: null, after: input },
        summary: `Deleted webhook subscription ${input.resource_subscription_id}.`,
      };
    },
  }, callerHash);
}
