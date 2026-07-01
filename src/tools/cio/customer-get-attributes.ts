import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerAttributes } from '../../customerio/full-client.js';

export function registerCioCustomerGetAttributes(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_get_attributes',
    category: 'read',
    annotations: {
      title: 'Get Customer.io customer attributes',
      description: 'Fetch all attributes stored for a customer via App API GET /customers/{id}/attributes. Returns the full attribute map including created_at, email, and any custom fields.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id).'),
    },
    outputShape: {
      attributes: z.unknown(),
    },
    handler: async (input, ctx) => {
      const attributes = await getCustomerAttributes({ customer_id: input.customer_id, correlationId: ctx.correlationId });
      return { data: { attributes } };
    },
  }, callerHash);
}
