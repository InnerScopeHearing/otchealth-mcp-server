import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcDetachTagFromConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationTagDetach(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_tag_detach',
    category: 'write_simple',
    annotations: {
      title: 'Detach a tag from an Intercom conversation',
      description: 'Remove a tag from a conversation via DELETE /conversations/:id/tags/:tag_id. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID.'),
      tag_id: z.string().describe('Intercom tag ID to detach.'),
      admin_id: z.string().describe('Intercom admin ID performing the untagging action.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string(),
      tag_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: input.conversation_id, tag_id: input.tag_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would detach tag ${input.tag_id} from conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcDetachTagFromConversation({
        conversation_id: input.conversation_id,
        tag_id: input.tag_id,
        admin_id: input.admin_id,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} detached from conversation ${input.conversation_id}.`,
      };
    },
  }, callerHash);
}
