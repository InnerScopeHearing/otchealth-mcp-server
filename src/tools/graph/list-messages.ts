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
      description: 'List recent messages in one of the allowlisted customer-service / COO mailboxes (see the `mailbox` param, GRAPH_CS_MAILBOXES), OR, for EXEC_RING callers only, one of the executive mailboxes on GRAPH_EXEC_MAILBOXES (e.g. matthew@innd.com, ap@innd.com, accounting@hearingassist.com, cfo@innd.com). Supports a Graph $search KQL query (`search`), substring filters on subject/sender (`subject_contains`/`from_contains`), an attachment filter (`has_attachments`), and an upper time bound (`until`) alongside the existing `since`. Read-only. Defaults to coo@otchealthmart.com for back-compat.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      mailbox: z.string().optional().describe('Mailbox UPN to list (e.g. care@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist. Defaults to coo@otchealthmart.com.'),
      folder: z.string().optional().describe('Mail folder (default "inbox"). Options: inbox, sentitems, drafts, deleteditems.'),
      top: z.number().int().min(1).max(50).optional().describe('Number of messages to return (max 50).'),
      filter: z.string().optional().describe('OData filter expression (e.g. "isRead eq false"). Combined with since/until/unread_only/has_attachments via AND if given. If this uses contains(/startswith(, results are sorted client-side (Graph rejects those combined with $orderby). Mutually exclusive with `search` in practice -- prefer `search` for full-text/attachment KQL queries.'),
      since: z.string().optional().describe('ISO 8601 datetime. Only messages received on/after this time.'),
      until: z.string().optional().describe('ISO 8601 datetime. Only messages received on/before this time (pairs with `since`).'),
      unread_only: z.boolean().optional().describe('Only return unread messages.'),
      search: z.string().optional().describe('Graph $search KQL query, e.g. \'subject:statement hasAttachments:true received>=2024-01-01\'. When set, this is the ONLY query option applied besides `top` -- Graph rejects $search combined with $filter or $orderby -- and results are sorted client-side by receivedDateTime desc.'),
      subject_contains: z.string().optional().describe('Case-sensitive substring match on subject (OData contains()). Forces client-side sort (see `filter`).'),
      from_contains: z.string().optional().describe('Case-sensitive substring match on the sender address (OData contains()). Forces client-side sort (see `filter`).'),
      has_attachments: z.boolean().optional().describe('Only return messages with (true) or without (false) attachments.'),
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
