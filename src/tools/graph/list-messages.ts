import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessages } from '../../graph/api-client.js';

export function registerGraphListMessages(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_list_messages',
    category: 'read',
    annotations: {
      title: 'List COO inbox messages',
      description: 'List recent messages in the COO mailbox (coo@otchealthmart.com). Read-only.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      folder: z.string().optional().describe('Mail folder (default "inbox"). Options: inbox, sentitems, drafts, deleteditems.'),
      top: z.number().int().min(1).max(50).optional().describe('Number of messages to return (max 50).'),
      filter: z.string().optional().describe('OData filter expression (e.g. "isRead eq false").'),
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
    },
    handler: async (input, _ctx) => {
      const msgs = await listMessages({ folder: input.folder, top: input.top, filter: input.filter });
      const mapped = msgs.map((m: any) => ({
        id: m.id ?? '',
        subject: m.subject ?? '',
        from: m.from?.emailAddress?.address ?? '',
        received: m.receivedDateTime ?? '',
        is_read: m.isRead ?? false,
        preview: (m.bodyPreview ?? '').slice(0, 200),
      }));
      return {
        data: { messages: mapped, count: mapped.length },
        summary: `Found ${mapped.length} message(s) in ${input.folder ?? 'inbox'}.`,
      };
    },
  }, callerHash);
}
