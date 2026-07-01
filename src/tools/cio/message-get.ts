import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMessage } from '../../customerio/full-client.js';

export function registerCioMessageGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_message_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io message delivery record',
      description: 'Fetch full details of a single sent message via App API GET /messages/{id}. Returns delivery status, recipient, campaign, content snapshot, and event timeline (sent, opened, clicked, etc.).',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().min(1).describe('The delivery ID of the message (e.g. from cio_customer_get_messages).'),
    },
    outputShape: {
      message: z.unknown(),
    },
    handler: async (input, ctx) => {
      const message = await getMessage({ message_id: input.message_id, correlationId: ctx.correlationId });
      return { data: { message } };
    },
  }, callerHash);
}
