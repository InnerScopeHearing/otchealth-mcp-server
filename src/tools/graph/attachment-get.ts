import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getAttachment } from '../../graph/full-client.js';

export function registerGraphAttachmentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_attachment_get',
    category: 'read',
    annotations: {
      title: 'Get a specific email attachment',
      description: 'Retrieve a specific attachment (including base64 contentBytes) from a message via GET /users/{sender}/messages/{id}/attachments/{attachmentId}. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID.'),
      attachment_id: z.string().describe('The attachment ID to retrieve.'),
    },
    outputShape: {
      id: z.string(),
      name: z.string(),
      content_type: z.string(),
      size: z.number(),
      content_bytes_b64: z.string().describe('Base64-encoded file content.'),
    },
    handler: async (input, _ctx) => {
      const a = await getAttachment(input.message_id, input.attachment_id);
      return {
        data: {
          id: a.id ?? '',
          name: a.name ?? '',
          content_type: a.contentType ?? '',
          size: a.size ?? 0,
          content_bytes_b64: a.contentBytes ?? '',
        },
        summary: `Retrieved attachment "${a.name}" (${a.size ?? 0} bytes) from message ${input.message_id}.`,
      };
    },
  }, callerHash);
}
