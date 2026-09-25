import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateContact } from '../../intercom/full-client.js';
import {
  COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
  COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
  projectContactUpdateForCooChat,
} from './coo-synthetic-contact.js';

export function registerIntercomContactUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom contact',
      description: 'Update fields on an Intercom contact via PUT /contacts/:id. COO Chat is limited to one synthetic contact and its fixed verification name. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to update.'),
      email: z.string().email().optional().describe('New email address.'),
      name: z.string().optional().describe('New full name.'),
      phone: z.string().optional().describe('New phone number (E.164 preferred).'),
      external_id: z.string().optional().describe('Your system identifier for this contact.'),
      avatar: z.string().url().optional().describe('URL of contact avatar image.'),
      unsubscribed_from_emails: z.boolean().optional().describe('Set to true to unsubscribe contact from emails.'),
      custom_attributes: z.record(z.unknown()).optional().describe('Custom attribute key-value pairs.'),
    },
    connectorInputShapeByLane: {
      coo: {
        contact_id: z.string().describe(`Only the approved synthetic contact ID (${COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID}) is accepted.`),
        name: z.string().optional().describe(`Only this value is accepted: ${COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME}.`),
      },
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
    },
    handler: async (input, ctx) => {
      const update = projectContactUpdateForCooChat(input);
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: update.contact_id },
          audit: { before: null, after: update },
          summary: `DRY RUN: would update contact ${update.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateContact(update);
      return {
        data: { executed: true, dry_run: false, contact_id: update.contact_id },
        audit: { before: null, after: update },
        summary: `Contact ${update.contact_id} updated.`,
      };
    },
  }, callerHash);
}
