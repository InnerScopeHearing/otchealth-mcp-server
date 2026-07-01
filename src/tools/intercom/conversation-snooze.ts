import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcSnoozeConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationSnooze(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_snooze',
    category: 'write_simple',
    annotations: {
      title: 'Snooze an Intercom conversation',
      description: 'Snooze a conversation until a specified Unix timestamp via POST /conversations/:id/parts with message_type=snoozed. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID to snooze.'),
      admin_id: z.string().describe('Intercom admin ID performing the snooze action.'),
      snoozed_until: z.number().int().describe('Unix timestamp (seconds) when the conversation should wake up.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string(),
      snoozed_until: z.number(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: input.conversation_id, snoozed_until: input.snoozed_until },
          audit: { before: null, after: input },
          summary: `DRY RUN: would snooze conversation ${input.conversation_id} until ${new Date(input.snoozed_until * 1000).toISOString()}. Pass dry_run=false to apply.`,
        };
      }
      await fcSnoozeConversation({
        conversation_id: input.conversation_id,
        admin_id: input.admin_id,
        snoozed_until: input.snoozed_until,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id, snoozed_until: input.snoozed_until },
        audit: { before: null, after: input },
        summary: `Conversation ${input.conversation_id} snoozed until ${new Date(input.snoozed_until * 1000).toISOString()}.`,
      };
    },
  }, callerHash);
}
