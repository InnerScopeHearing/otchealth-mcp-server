import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUnarchiveContact } from '../../intercom/full-client.js';

export function registerIntercomContactUnarchive(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_unarchive',
    category: 'write_simple',
    annotations: {
      title: 'Unarchive an Intercom contact',
      description: 'Restore a previously archived Intercom contact. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to unarchive.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
      unarchived: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id, unarchived: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would unarchive contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUnarchiveContact(input.contact_id);
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, unarchived: true },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} unarchived.`,
      };
    },
  }, callerHash);
}
