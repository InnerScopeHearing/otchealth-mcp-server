import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetTicket } from '../../intercom/full-client.js';

export function registerIntercomTicketGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom ticket by ID',
      description: 'Retrieve a single ticket by its ID via GET /tickets/:id. Returns ticket attributes, state, and contacts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      ticket_id: z.string().describe('Intercom ticket ID.'),
    },
    outputShape: {
      ticket: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const ticket = await fcGetTicket(input.ticket_id);
      return {
        data: { ticket },
        summary: `Ticket ${input.ticket_id} retrieved.`,
      };
    },
  }, callerHash);
}
