import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcArchiveContact } from '../../intercom/full-client.js';

export function registerIntercomContactArchive(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_archive',
    category: 'write_simple',
    annotations: {
      title: 'Archive an Intercom contact',
      description: 'Archive (soft-delete) a contact in Intercom. Archived contacts are hidden but recoverable via unarchive. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to archive.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
      archived: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id, archived: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would archive contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcArchiveContact(input.contact_id);
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, archived: true },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} archived.`,
      };
    },
  }, callerHash);
}
