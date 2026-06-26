import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { forwardMessage } from '../../graph/full-client.js';

export function registerGraphMessageForward(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_forward',
    category: 'write_simple',
    annotations: {
      title: 'Forward an email message',
      description: 'Forward an existing message to one or more recipients from the COO mailbox via POST /users/{sender}/messages/{id}/forward. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID to forward.'),
      to_recipients: z.string().describe('Comma-separated recipient email addresses.'),
      comment: z.string().optional().describe('Optional comment to prepend to the forwarded message.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_id: z.string(),
      to_recipients: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_id: input.message_id, to_recipients: input.to_recipients },
          audit: { before: null, after: input },
          summary: `DRY RUN: would forward message ${input.message_id} to ${input.to_recipients}. Pass dry_run=false to apply.`,
        };
      }
      const recipients = input.to_recipients.split(',').map((e: string) => e.trim()).filter(Boolean);
      await forwardMessage({ messageId: input.message_id, toRecipients: recipients, comment: input.comment });
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id, to_recipients: input.to_recipients },
        audit: { before: null, after: input },
        summary: `Message ${input.message_id} forwarded to ${input.to_recipients}.`,
      };
    },
  }, callerHash);
}
