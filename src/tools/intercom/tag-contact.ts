import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcTagContact } from '../../intercom/full-client.js';

export function registerIntercomTagContact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_contact',
    category: 'write_simple',
    annotations: {
      title: 'Tag an Intercom contact',
      description: 'Apply a tag to a contact via POST /contacts/:contact_id/tags. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to tag.'),
      tag_id: z.string().describe('Intercom tag ID to apply.'),
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
          summary: `DRY RUN: would tag contact ${input.contact_id} with tag ${input.tag_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcTagContact({ contact_id: input.contact_id, tag_id: input.tag_id });
      return {
        data: { executed: true, dry_run: false, contact_id: input.contact_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Contact ${input.contact_id} tagged with tag ${input.tag_id}.`,
      };
    },
  }, callerHash);
}
