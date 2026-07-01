import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDeleteContact } from '../../intercom/full-client.js';

export function registerIntercomContactDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete an Intercom contact (irreversible)',
      description: 'Permanently delete a contact from Intercom via DELETE /contacts/:id. This is irreversible — all associated data is removed. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDeleteContact(input.contact_id);
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, deleted: true },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
