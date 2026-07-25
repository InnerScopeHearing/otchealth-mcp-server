import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMessage } from '../../graph/api-client.js';

export function registerGraphGetMessage(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_get_message',
    category: 'read',
    annotations: {
      title: 'Get full message body + attachment metadata',
      description: 'Fetch the full body and attachment metadata for one message in an allowlisted mailbox (see GRAPH_CS_MAILBOXES). Read-only. Use graph_list_messages first to get a message id.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      mailbox: z.string().describe('Mailbox UPN the message lives in (e.g. care@otchealthmart.com). Must be on the GRAPH_CS_MAILBOXES allowlist.'),
      message_id: z.string().describe('The message id, from graph_list_messages.'),
    },
    outputShape: {
      id: z.string(),
      subject: z.string(),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      received: z.string(),
      is_read: z.boolean(),
      body: z.string(),
      body_type: z.string(),
      has_attachments: z.boolean(),
      attachments: z.array(z.object({
        id: z.string(),
        name: z.string(),
        content_type: z.string(),
        size: z.number(),
        is_inline: z.boolean(),
      })),
    },
    handler: async (input, _ctx) => {
      const m = await getMessage(input.mailbox, input.message_id);
      const attachments = (m._attachments ?? []).map((a: any) => ({
        id: a.id ?? '',
        name: a.name ?? '',
        content_type: a.contentType ?? '',
        size: a.size ?? 0,
        is_inline: a.isInline ?? false,
      }));
      return {
        data: {
          id: m.id ?? '',
          subject: m.subject ?? '',
          from: m.from?.emailAddress?.address ?? '',
          to: (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
          cc: (m.ccRecipients ?? []).map((r: any) => r.emailAddress?.address ?? ''),
          received: m.receivedDateTime ?? '',
          is_read: m.isRead ?? false,
          body: m.body?.content ?? '',
          body_type: m.body?.contentType ?? 'text',
          has_attachments: m.hasAttachments ?? false,
          attachments,
        },
        summary: `Fetched message "${m.subject ?? ''}" from ${input.mailbox} (${attachments.length} attachment(s)).`,
      };
    },
  }, callerHash);
}
