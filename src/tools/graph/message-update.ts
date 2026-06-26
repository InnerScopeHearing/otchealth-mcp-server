import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateMessage } from '../../graph/full-client.js';

export function registerGraphMessageUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_update',
    category: 'write_simple',
    annotations: {
      title: 'Update message properties (categories / flag)',
      description: 'Update metadata on a message in the COO mailbox — categories, follow-up flag status, or isRead — via PATCH /users/{sender}/messages/{id}. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID to update.'),
      categories: z.array(z.string()).optional().describe('List of category strings to assign (replaces existing).'),
      flag_status: z.enum(['notFlagged', 'flagged', 'complete']).optional().describe('Follow-up flag status.'),
      is_read: z.boolean().optional().describe('Mark message as read (true) or unread (false).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_id: input.message_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update message ${input.message_id} properties. Pass dry_run=false to apply.`,
        };
      }
      await updateMessage({
        messageId: input.message_id,
        categories: input.categories,
        flag: input.flag_status ? { flagStatus: input.flag_status } : undefined,
        isRead: input.is_read,
      });
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id },
        audit: { before: null, after: input },
        summary: `Message ${input.message_id} updated.`,
      };
    },
  }, callerHash);
}
