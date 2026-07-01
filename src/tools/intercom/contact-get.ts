import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetContact } from '../../intercom/full-client.js';

export function registerIntercomContactGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom contact by ID',
      description: 'Retrieve full details of a single Intercom contact (user or lead) by their Intercom contact ID.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
    },
    outputShape: {
      contact: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const contact = await fcGetContact(input.contact_id);
      return {
        data: { contact },
        summary: `Contact ${input.contact_id} retrieved.`,
      };
    },
  }, callerHash);
}
