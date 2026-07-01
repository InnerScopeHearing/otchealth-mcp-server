import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSubscribers } from '../../gumroad/full-client.js';

export function registerGumroadSubscriberList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_subscriber_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad subscribers',
      description: 'List all active subscribers for a Gumroad membership/subscription product. Optionally filter by email.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID (must be a membership/subscription product).'),
      email: z.string().email().optional().describe('Filter to a specific subscriber email address.'),
    },
    outputShape: {
      subscribers: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listSubscribers(input.product_id, input.email);
      const subs = resp.subscribers ?? [];
      return {
        data: { subscribers: subs, count: subs.length },
        summary: `${subs.length} subscriber(s) for product ${input.product_id}${input.email ? ` (email=${input.email})` : ''}.`,
      };
    },
  }, callerHash);
}
