import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { replyEmail } from '../../graph/write-client.js';

export function registerGraphReplyEmail(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_reply_email',
    category: 'write_simple',
    annotations: {
      title: 'Reply to an email as COO',
      description: 'Send a reply to an existing message in the COO mailbox via Microsoft Graph POST /users/{sender}/messages/{id}/reply. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message id to reply to (from graph_list_messages).'),
      comment: z.string().describe('Reply body text. Prepended to the quoted original in the sent message.'),
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
          summary: `DRY RUN: would reply to message ${input.message_id}. Pass dry_run=false to apply.`,
        };
      }
      await replyEmail({ messageId: input.message_id, comment: input.comment });
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id },
        audit: { before: null, after: input },
        summary: `Reply sent to message ${input.message_id}.`,
      };
    },
  }, callerHash);
}
