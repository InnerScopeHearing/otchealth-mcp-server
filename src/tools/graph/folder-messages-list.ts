import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFolderMessages } from '../../graph/full-client.js';

export function registerGraphFolderMessagesList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_folder_messages_list',
    category: 'read',
    annotations: {
      title: 'List messages in a specific mail folder',
      description: 'Retrieve messages from a specific folder by folder ID via GET /users/{sender}/mailFolders/{folderId}/messages. More targeted than graph_list_messages. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      folder_id: z.string().describe('Mail folder ID or well-known name (inbox, drafts, sentitems, deleteditems).'),
      top: z.number().int().min(1).max(100).optional().describe('Number of messages to return (max 100, default 25).'),
      filter: z.string().optional().describe('OData $filter expression, e.g. "isRead eq false".'),
    },
    outputShape: {
      messages: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        from: z.string(),
        received: z.string(),
        is_read: z.boolean(),
        has_attachments: z.boolean(),
        preview: z.string(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const msgs = await listFolderMessages({
        folderId: input.folder_id,
        top: input.top ?? 25,
        filter: input.filter,
        select: 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview',
      });
      const mapped = msgs.map((m: any) => ({
        id: m.id ?? '',
        subject: m.subject ?? '',
        from: m.from?.emailAddress?.address ?? '',
        received: m.receivedDateTime ?? '',
        is_read: m.isRead ?? false,
        has_attachments: m.hasAttachments ?? false,
        preview: (m.bodyPreview ?? '').slice(0, 200),
      }));
      return {
        data: { messages: mapped, count: mapped.length },
        summary: `Found ${mapped.length} message(s) in folder ${input.folder_id}.`,
      };
    },
  }, callerHash);
}
