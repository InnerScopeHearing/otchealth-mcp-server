import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSubscriber } from '../../gumroad/full-client.js';

export function registerGumroadSubscriberGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_subscriber_get',
    category: 'read',
    annotations: {
      title: 'Get single Gumroad subscriber',
      description: 'Retrieve details for a specific Gumroad subscriber by subscriber ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      subscriber_id: z.string().describe('Gumroad subscriber ID.'),
    },
    outputShape: {
      subscriber: z.record(z.unknown()),
    },
    handler: async (input, _ctx) => {
      const resp = await getSubscriber(input.subscriber_id);
      const sub = resp.subscriber ?? resp;
      return {
        data: { subscriber: sub },
        summary: `Subscriber ${input.subscriber_id}: ${sub.email ?? 'unknown'} (status=${sub.status ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
