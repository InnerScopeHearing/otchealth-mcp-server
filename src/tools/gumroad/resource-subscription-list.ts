import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listResourceSubscriptions } from '../../gumroad/full-client.js';

export function registerGumroadResourceSubscriptionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_resource_subscription_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad webhook subscriptions',
      description: 'List all resource subscription webhooks registered on the account. Optionally filter by resource name (e.g. "sale", "refund").',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      resource_name: z.enum([
        'sale', 'refund', 'dispute', 'dispute_won',
        'cancellation', 'subscription_updated', 'subscription_ended', 'subscription_restarted',
      ]).optional().describe('Filter by resource event type. Omit to list all.'),
    },
    outputShape: {
      resource_subscriptions: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listResourceSubscriptions(input.resource_name);
      const subs = resp.resource_subscriptions ?? [];
      return {
        data: { resource_subscriptions: subs, count: subs.length },
        summary: `${subs.length} webhook subscription(s)${input.resource_name ? ` for event "${input.resource_name}"` : ''}.`,
      };
    },
  }, callerHash);
}
