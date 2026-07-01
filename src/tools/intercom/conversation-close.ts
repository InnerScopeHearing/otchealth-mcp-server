import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcCloseConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationClose(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_close',
    category: 'write_simple',
    annotations: {
      title: 'Close an Intercom conversation',
      description: 'Close an open Intercom conversation via POST /conversations/:id/parts with message_type=close. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID to close.'),
      admin_id: z.string().describe('Intercom admin ID performing the close action.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: input.conversation_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would close conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcCloseConversation({ conversation_id: input.conversation_id, admin_id: input.admin_id });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id },
        audit: { before: null, after: input },
        summary: `Conversation ${input.conversation_id} closed.`,
      };
    },
  }, callerHash);
}
