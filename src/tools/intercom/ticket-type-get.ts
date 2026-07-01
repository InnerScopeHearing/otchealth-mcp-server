import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetTicketType } from '../../intercom/full-client.js';

export function registerIntercomTicketTypeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_type_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom ticket type by ID',
      description: 'Retrieve a single ticket type by ID via GET /ticket_types/:id. Returns attributes schema.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      ticket_type_id: z.string().describe('Intercom ticket type ID.'),
    },
    outputShape: {
      ticket_type: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const ticket_type = await fcGetTicketType(input.ticket_type_id);
      return {
        data: { ticket_type },
        summary: `Ticket type ${input.ticket_type_id} retrieved.`,
      };
    },
  }, callerHash);
}
