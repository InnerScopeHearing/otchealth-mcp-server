import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSubscriberV1 } from '../../revenuecat/full-client.js';

export function registerRevenueCatSubscriberGetV1(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_subscriber_get_v1',
    category: 'read',
    annotations: {
      title: 'Get subscriber (v1)',
      description: 'Fetch subscriber info via the v1 REST API — includes entitlements, subscriptions, and non-subscriptions keyed by product ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      app_user_id: z.string().describe('App user ID (subscriber identifier)'),
    },
    outputShape: { subscriber: z.unknown() },
    handler: async (input) => {
      const r: any = await getSubscriberV1(input.app_user_id);
      return { data: { subscriber: r?.subscriber ?? r }, summary: `Subscriber info for ${input.app_user_id}.` };
    },
  }, callerHash);
}
