import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcAssignConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationAssign(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_assign',
    category: 'write_simple',
    annotations: {
      title: 'Assign an Intercom conversation',
      description: 'Assign a conversation to an admin (and optionally a team) via POST /conversations/:id/parts with message_type=assignment. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID to assign.'),
      assignee_id: z.string().describe('Intercom admin ID to assign the conversation to.'),
      team_id: z.string().optional().describe('Intercom team ID to assign the conversation to (optional).'),
      admin_id: z.string().describe('Intercom admin ID performing this assignment action.'),
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
          summary: `DRY RUN: would assign conversation ${input.conversation_id} to admin ${input.assignee_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcAssignConversation({
        conversation_id: input.conversation_id,
        assignee_id: input.assignee_id,
        team_id: input.team_id,
        admin_id: input.admin_id,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id },
        audit: { before: null, after: input },
        summary: `Conversation ${input.conversation_id} assigned to admin ${input.assignee_id}.`,
      };
    },
  }, callerHash);
}
