import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBroadcast } from '../../customerio/full-client.js';

export function registerCioBroadcastGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_broadcast_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io broadcast',
      description: 'Fetch full details of a single broadcast (newsletter) via App API GET /newsletters/{id}. Returns name, state, subject, from address, and recipient configuration.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      broadcast_id: z.number().int().positive().describe('Numeric ID of the Customer.io broadcast/newsletter.'),
    },
    outputShape: {
      broadcast: z.unknown(),
    },
    handler: async (input, ctx) => {
      const broadcast = await getBroadcast({ broadcast_id: input.broadcast_id, correlationId: ctx.correlationId });
      return { data: { broadcast } };
    },
  }, callerHash);
}
