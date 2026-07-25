import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { markRead } from '../../graph/api-client.js';

export function registerGraphMarkRead(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_mark_read',
    category: 'write_simple',
    annotations: {
      title: 'Mark a message read/unread',
      description: 'Set the isRead flag on a message in an allowlisted mailbox (see GRAPH_CS_MAILBOXES). Uses application permission Mail.ReadWrite (already granted).',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      mailbox: z.string().describe('Mailbox UPN the message lives in (e.g. care@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist.'),
      message_id: z.string().describe('The message id, from graph_list_messages.'),
      is_read: z.boolean().describe('true to mark read, false to mark unread.'),
    },
    outputShape: {
      message_id: z.string(),
      is_read: z.boolean(),
    },
    handler: async (input, _ctx) => {
      await markRead(input.mailbox, input.message_id, input.is_read);
      return {
        data: { message_id: input.message_id, is_read: input.is_read },
        summary: `Marked message ${input.message_id} in ${input.mailbox} as ${input.is_read ? 'read' : 'unread'}.`,
        audit: { after: { is_read: input.is_read } },
      };
    },
  }, callerHash);
}
