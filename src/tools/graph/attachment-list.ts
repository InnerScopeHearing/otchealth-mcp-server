import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAttachments } from '../../graph/full-client.js';

export function registerGraphAttachmentList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_attachment_list',
    category: 'read',
    annotations: {
      title: 'List attachments on an email message',
      description: 'List all attachments on a specific message via GET /users/{sender}/messages/{id}/attachments. Returns metadata (name, size, contentType) but not the file bytes. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID whose attachments to list.'),
    },
    outputShape: {
      attachments: z.array(z.object({
        id: z.string(),
        name: z.string(),
        content_type: z.string(),
        size: z.number(),
        is_inline: z.boolean(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const attachments = await listAttachments(input.message_id);
      const mapped = attachments.map((a: any) => ({
        id: a.id ?? '',
        name: a.name ?? '',
        content_type: a.contentType ?? '',
        size: a.size ?? 0,
        is_inline: a.isInline ?? false,
      }));
      return {
        data: { attachments: mapped, count: mapped.length },
        summary: `Found ${mapped.length} attachment(s) on message ${input.message_id}.`,
      };
    },
  }, callerHash);
}
