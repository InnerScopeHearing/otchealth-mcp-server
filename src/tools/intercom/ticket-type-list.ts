import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListTicketTypes } from '../../intercom/full-client.js';

export function registerIntercomTicketTypeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_ticket_type_list',
    category: 'read',
    annotations: {
      title: 'List Intercom ticket types',
      description: 'Retrieve all ticket types defined in the Intercom workspace via GET /ticket_types.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      ticket_types: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListTicketTypes();
      const ticket_types = resp.data ?? resp.ticket_types ?? [];
      return {
        data: { ticket_types, count: ticket_types.length },
        summary: `Found ${ticket_types.length} ticket type(s).`,
      };
    },
  }, callerHash);
}
