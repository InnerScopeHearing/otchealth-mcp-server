import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUpdateContact } from '../../intercom/full-client.js';

export function registerIntercomContactUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_update',
    category: 'write_simple',
    annotations: {
      title: 'Update an Intercom contact',
      description: 'Update fields on an existing Intercom contact via PUT /contacts/:id. Defaults to dry_run.',
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
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUpdateContact(input);
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} updated.`,
      };
    },
  }, callerHash);
}
