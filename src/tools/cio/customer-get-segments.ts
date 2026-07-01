import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerSegments } from '../../customerio/full-client.js';

export function registerCioCustomerGetSegments(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_get_segments',
    category: 'read',
    annotations: {
      title: 'Get segments for a Customer.io customer',
      description: 'Fetch all segments a customer belongs to via App API GET /customers/{id}/segments. Returns segment IDs, names, and types.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id).'),
    },
    outputShape: {
      segments: z.unknown(),
    },
    handler: async (input, ctx) => {
      const segments = await getCustomerSegments({ customer_id: input.customer_id, correlationId: ctx.correlationId });
      return { data: { segments } };
    },
  }, callerHash);
}
