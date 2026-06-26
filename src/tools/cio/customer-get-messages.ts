import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomerMessages } from '../../customerio/full-client.js';

export function registerCioCustomerGetMessages(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_get_messages',
    category: 'read',
    annotations: {
      title: 'Get messages sent to a Customer.io customer',
      description: 'Fetch the message delivery history for a specific customer via App API GET /customers/{id}/messages. Returns emails, push notifications, and SMS with delivery status.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().min(1).describe('Customer identifier (email, id, or cio_id).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return (default 25).'),
      start: z.string().optional().describe('Pagination cursor from a previous response.'),
      type: z.string().optional().describe('Message type filter (e.g. "email", "push", "sms", "webhook").'),
    },
    outputShape: {
      messages: z.unknown(),
    },
    handler: async (input, ctx) => {
      const messages = await getCustomerMessages({
        customer_id: input.customer_id,
        limit: input.limit,
        start: input.start,
        type: input.type,
        correlationId: ctx.correlationId,
      });
      return { data: { messages } };
    },
  }, callerHash);
}
