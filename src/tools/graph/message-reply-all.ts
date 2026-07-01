import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { replyAll } from '../../graph/full-client.js';

export function registerGraphMessageReplyAll(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_reply_all',
    category: 'write_simple',
    annotations: {
      title: 'Reply-all to an email message',
      description: 'Send a reply to all recipients on a message from the COO mailbox via POST /users/{sender}/messages/{id}/replyAll. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID to reply-all to.'),
      comment: z.string().describe('Reply body text to prepend.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_id: input.message_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would reply-all to message ${input.message_id}. Pass dry_run=false to apply.`,
        };
      }
      await replyAll({ messageId: input.message_id, comment: input.comment });
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id },
        audit: { before: null, after: input },
        summary: `Reply-all sent for message ${input.message_id}.`,
      };
    },
  }, callerHash);
}
