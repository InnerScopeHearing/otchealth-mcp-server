import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBroadcastStatus } from '../../customerio/full-client.js';

export function registerCioBroadcastGetStatus(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_broadcast_get_status',
    category: 'read',
    annotations: {
      title: 'Get Customer.io broadcast send status',
      description: 'Fetch the send status and trigger history for a broadcast campaign via App API GET /campaigns/{id}/triggers. Shows whether the broadcast is scheduled, sending, or completed.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      broadcast_id: z.number().int().positive().describe('Numeric campaign ID of the broadcast to check status for.'),
    },
    outputShape: {
      status: z.unknown(),
    },
    handler: async (input, ctx) => {
      const status = await getBroadcastStatus({ broadcast_id: input.broadcast_id, correlationId: ctx.correlationId });
      return { data: { status } };
    },
  }, callerHash);
}
