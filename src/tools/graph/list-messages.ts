import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessages } from '../../graph/api-client.js';

export function registerGraphListMessages(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_list_messages',
    category: 'read',
    annotations: {
      title: 'List messages in an allowlisted mailbox',
      description: 'List recent messages in one of the allowlisted customer-service / COO mailboxes (see the `mailbox` param, GRAPH_CS_MAILBOXES). Read-only. Defaults to coo@otchealthmart.com for back-compat.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      mailbox: z.string().optional().describe('Mailbox UPN to list (e.g. care@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist. Defaults to coo@otchealthmart.com.'),
      folder: z.string().optional().describe('Mail folder (default "inbox"). Options: inbox, sentitems, drafts, deleteditems.'),
      top: z.number().int().min(1).max(50).optional().describe('Number of messages to return (max 50).'),
      filter: z.string().optional().describe('OData filter expression (e.g. "isRead eq false"). Combined with since/unread_only via AND if both given.'),
      since: z.string().optional().describe('ISO 8601 datetime. Only messages received on/after this time.'),
      unread_only: z.boolean().optional().describe('Only return unread messages.'),
    },
    outputShape: {
      messages: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        from: z.string(),
        received: z.string(),
        is_read: z.boolean(),
        preview: z.string(),
      })),
      count: z.number(),
      mailbox: z.string(),
    },
    handler: async (input, _ctx) => {
      const msgs = await listMessages({
        mailbox: input.mailbox,
        folder: input.folder,
        top: input.top,
        filter: input.filter,
        since: input.since,
        unreadOnly: input.unread_only,
      });
      const mapped = msgs.map((m: any) => ({
        id: m.id ?? '',
        subject: m.subject ?? '',
        from: m.from?.emailAddress?.address ?? '',
        received: m.receivedDateTime ?? '',
        is_read: m.isRead ?? false,
        preview: (m.bodyPreview ?? '').slice(0, 200),
      }));
      const mailboxUsed = input.mailbox ?? 'coo@otchealthmart.com';
      return {
        data: { messages: mapped, count: mapped.length, mailbox: mailboxUsed },
        summary: `Found ${mapped.length} message(s) in ${mailboxUsed} / ${input.folder ?? 'inbox'}.`,
      };
    },
  }, callerHash);
}
