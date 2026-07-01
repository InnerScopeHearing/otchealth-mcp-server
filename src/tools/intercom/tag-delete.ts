import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDeleteTag } from '../../intercom/full-client.js';

export function registerIntercomTagDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete an Intercom tag (irreversible)',
      description: 'Permanently delete a tag from Intercom via DELETE /tags/:id. The tag is removed from all contacts, conversations, and companies. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      tag_id: z.string().describe('Intercom tag ID to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      tag_id: z.string(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, tag_id: input.tag_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete tag ${input.tag_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDeleteTag(input.tag_id);
      return {
        data: { executed: true, dry_run: false, tag_id: input.tag_id, deleted: true },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
