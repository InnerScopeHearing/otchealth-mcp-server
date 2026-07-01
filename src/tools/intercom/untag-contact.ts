import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcUntagContact } from '../../intercom/full-client.js';

export function registerIntercomUntagContact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_untag_contact',
    category: 'write_simple',
    annotations: {
      title: 'Remove a tag from an Intercom contact',
      description: 'Remove a tag from a contact via DELETE /contacts/:contact_id/tags/:tag_id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
      tag_id: z.string().describe('Intercom tag ID to remove.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      contact_id: z.string(),
      tag_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, contact_id: input.contact_id, tag_id: input.tag_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would remove tag ${input.tag_id} from contact ${input.contact_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcUntagContact({ contact_id: input.contact_id, tag_id: input.tag_id });
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} removed from contact ${input.contact_id}.`,
      };
    },
  }, callerHash);
}
