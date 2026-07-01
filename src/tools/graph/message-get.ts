import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMessage } from '../../graph/full-client.js';

export function registerGraphMessageGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_get',
    category: 'read',
    annotations: {
      title: 'Get a single email message',
      description: 'Retrieve the full details of a specific message by ID from the COO mailbox via GET /users/{sender}/messages/{id}. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID to retrieve.'),
    },
    outputShape: {
      id: z.string(),
      subject: z.string(),
      from: z.string(),
      received: z.string(),
      is_read: z.boolean(),
      body_preview: z.string(),
      body_content: z.string(),
      body_content_type: z.string(),
      to_recipients: z.array(z.string()),
      cc_recipients: z.array(z.string()),
      has_attachments: z.boolean(),
      web_link: z.string(),
    },
    handler: async (input, _ctx) => {
      const m = await getMessage(input.message_id);
      const toList: string[] = (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address ?? '');
      const ccList: string[] = (m.ccRecipients ?? []).map((r: any) => r.emailAddress?.address ?? '');
      return {
        data: {
          id: m.id ?? '',
          subject: m.subject ?? '',
          from: m.from?.emailAddress?.address ?? '',
          received: m.receivedDateTime ?? '',
          is_read: m.isRead ?? false,
          body_preview: (m.bodyPreview ?? '').slice(0, 500),
          body_content: m.body?.content ?? '',
          body_content_type: m.body?.contentType ?? 'Text',
          to_recipients: toList,
          cc_recipients: ccList,
          has_attachments: m.hasAttachments ?? false,
          web_link: m.webLink ?? '',
        },
        summary: `Retrieved message "${m.subject}" from ${m.from?.emailAddress?.address ?? 'unknown'}.`,
      };
    },
  }, callerHash);
}
