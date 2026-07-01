import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addAttachment } from '../../graph/full-client.js';

export function registerGraphAttachmentAdd(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_attachment_add',
    category: 'write_simple',
    annotations: {
      title: 'Add a file attachment to a draft message',
      description: 'Add a base64-encoded file attachment to an existing draft message via POST /users/{sender}/messages/{id}/attachments. Only works on draft messages (not yet sent). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('Draft message ID to attach the file to.'),
      name: z.string().describe('Filename including extension, e.g. "report.pdf".'),
      content_type: z.string().describe('MIME type, e.g. "application/pdf" or "image/png".'),
      content_bytes_b64: z.string().describe('Base64-encoded file content.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      attachment_id: z.string().nullable(),
      name: z.string(),
      size: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, attachment_id: null, name: input.name, size: null },
          audit: { before: null, after: { message_id: input.message_id, name: input.name, content_type: input.content_type } },
          summary: `DRY RUN: would attach "${input.name}" to draft ${input.message_id}. Pass dry_run=false to apply.`,
        };
      }
      const att = await addAttachment({
        messageId: input.message_id,
        name: input.name,
        contentType: input.content_type,
        contentBytes: input.content_bytes_b64,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          attachment_id: att.id ?? null,
          name: att.name ?? input.name,
          size: att.size ?? null,
        },
        audit: { before: null, after: input },
        summary: `Attachment "${input.name}" added to draft ${input.message_id}.`,
      };
    },
  }, callerHash);
}
