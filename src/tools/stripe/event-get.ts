import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEvent } from '../../stripe/full-client.js';

export function registerStripeEventGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_event_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe event',
      description: 'Retrieve a single Stripe event by ID. Useful for debugging webhook deliveries.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      event_id: z.string().describe('Event ID (evt_...).'),
    },
    outputShape: {
      id: z.string(),
      type: z.string(),
      created: z.string(),
      livemode: z.boolean(),
      object_type: z.string().nullable(),
      object_id: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const e = await getEvent(input.event_id);
      return {
        data: {
          id: e.id,
          type: e.type,
          created: new Date(e.created * 1000).toISOString(),
          livemode: e.livemode,
          object_type: e.data?.object?.object ?? null,
          object_id: e.data?.object?.id ?? null,
        },
        summary: `Event ${e.id}: ${e.type} at ${new Date(e.created * 1000).toISOString()}.`,
      };
    },
  }, callerHash);
}
