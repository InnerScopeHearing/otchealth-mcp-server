import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteContact } from '../../graph/full-client.js';

export function registerGraphContactDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_contact_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete a contact',
      description: 'Permanently delete a contact from the COO mailbox contacts folder via DELETE /users/{sender}/contacts/{id}. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('The Graph contact ID to delete permanently.'),
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
          summary: `DRY RUN: would permanently delete contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteContact(input.contact_id);
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id },
        audit: { before: { contact_id: input.contact_id }, after: null },
        summary: `Contact ${input.contact_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
