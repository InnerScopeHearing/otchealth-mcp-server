import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { replyConversation } from '../../intercom/write-client.js';

export function registerIntercomReplyConversation(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_reply_conversation',
    category: 'write_simple',
    annotations: {
      title: 'Reply to an Intercom conversation',
      description: 'Send a customer-visible reply or an internal note to an Intercom conversation via POST /conversations/{id}/reply. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation id to reply to.'),
      body: z.string().describe('Reply body text (plain text or HTML).'),
      type: z.enum(['comment', 'note']).describe('"comment" sends the reply to the user; "note" is internal only.'),
      admin_id: z.string().optional().describe('Intercom admin id of the replying teammate (required for admin replies). Omit for automated/bot replies.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string(),
      type: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: input.conversation_id, type: input.type },
          audit: { before: null, after: input },
          summary: `DRY RUN: would ${input.type === 'note' ? 'add note to' : 'reply to'} conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await replyConversation({
        conversation_id: input.conversation_id,
        type: input.type,
        body: input.body,
        admin_id: input.admin_id,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id, type: input.type },
        audit: { before: null, after: input },
        summary: `${input.type === 'note' ? 'Note added to' : 'Reply sent to'} conversation ${input.conversation_id}.`,
      };
    },
  }, callerHash);
}
