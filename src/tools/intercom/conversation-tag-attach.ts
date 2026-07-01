import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcAttachTagToConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationTagAttach(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_tag_attach',
    category: 'write_simple',
    annotations: {
      title: 'Attach a tag to an Intercom conversation',
      description: 'Tag a conversation by attaching a tag via POST /conversations/:id/tags. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID.'),
      tag_id: z.string().describe('Intercom tag ID to attach.'),
      admin_id: z.string().describe('Intercom admin ID performing the tagging action.'),
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
          summary: `DRY RUN: would attach tag ${input.tag_id} to conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcAttachTagToConversation({
        conversation_id: input.conversation_id,
        tag_id: input.tag_id,
        admin_id: input.admin_id,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id, tag_id: input.tag_id },
        audit: { before: null, after: input },
        summary: `Tag ${input.tag_id} attached to conversation ${input.conversation_id}.`,
      };
    },
  }, callerHash);
}
