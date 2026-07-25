import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { markRead } from '../../graph/write-client.js';

export function registerGraphMarkRead(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_mark_read',
    category: 'write_simple',
    annotations: {
      title: 'Mark a mailbox message as read or unread',
      description: 'Set the isRead flag on a message via Microsoft Graph PATCH /users/{mailbox}/messages/{id}. Defaults to the COO mailbox; pass `mailbox` for one of the other allowlisted customer-service personas (see GRAPH_CS_MAILBOXES). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message id to update (from graph_list_messages).'),
      is_read: z.boolean().describe('true to mark as read; false to mark as unread.'),
      mailbox: z.string().optional().describe('Mailbox UPN the message lives in (e.g. care@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist. Defaults to coo@otchealthmart.com.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_id: z.string(),
      is_read: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_id: input.message_id, is_read: input.is_read },
          audit: { before: null, after: input },
          summary: `DRY RUN: would mark message ${input.message_id} as ${input.is_read ? 'read' : 'unread'}. Pass dry_run=false to apply.`,
        };
      }
      await markRead({ messageId: input.message_id, isRead: input.is_read, mailbox: input.mailbox });
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id, is_read: input.is_read },
        audit: { before: null, after: input },
        summary: `Message ${input.message_id} marked as ${input.is_read ? 'read' : 'unread'}.`,
      };
    },
  }, callerHash);
}
