import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBroadcastErrors } from '../../customerio/full-client.js';

export function registerCioBroadcastGetErrors(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_broadcast_get_errors',
    category: 'read',
    annotations: {
      title: 'Get Customer.io broadcast error metrics',
      description: 'Fetch error counts and breakdown for a broadcast send via App API GET /newsletters/{id}/metrics/errors. Returns bounces, failures, and unsubscribes grouped by error type.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      broadcast_id: z.number().int().positive().describe('Numeric ID of the broadcast/newsletter to retrieve errors for.'),
    },
    outputShape: {
      errors: z.unknown(),
    },
    handler: async (input, ctx) => {
      const errors = await getBroadcastErrors({ broadcast_id: input.broadcast_id, correlationId: ctx.correlationId });
      return { data: { errors } };
    },
  }, callerHash);
}
