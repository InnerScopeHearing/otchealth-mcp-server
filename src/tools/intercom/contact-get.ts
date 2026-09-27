import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetContact } from '../../intercom/full-client.js';
import {
  assertCooChatIntercomContactTarget,
  COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
  projectIntercomContactForCooChat,
} from './coo-synthetic-contact.js';

export function registerIntercomContactGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom contact by ID',
      description: 'Retrieve an Intercom contact by ID. COO Chat is restricted to the approved synthetic contact and receives only its ID and fixed verification name.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
    },
    connectorInputShapeByLane: {
      coo: {
        contact_id: z.string().describe(`Only the approved synthetic contact ID (${COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID}) is accepted.`),
      },
    },
    outputShape: {
      contact: z.unknown(),
    },
    handler: async (input, _ctx) => {
      assertCooChatIntercomContactTarget(input.contact_id);
      const contact = projectIntercomContactForCooChat(await fcGetContact(input.contact_id));
      return {
        data: { contact },
        summary: `Contact ${input.contact_id} retrieved.`,
      };
    },
  }, callerHash);
}
