import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcRunAssignmentRules } from '../../intercom/full-client.js';

export function registerIntercomConversationRunAssignmentRules(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_run_assignment_rules',
    category: 'write_simple',
    annotations: {
      title: 'Run assignment rules on an Intercom conversation',
      description: 'Trigger Intercom\'s configured assignment rules on a conversation via POST /conversations/:id/run_assignment_rules. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID to run assignment rules on.'),
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
          summary: `DRY RUN: would run assignment rules on conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await fcRunAssignmentRules({ conversation_id: input.conversation_id });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id },
        audit: { before: null, after: input },
        summary: `Assignment rules executed on conversation ${input.conversation_id}.`,
      };
    },
  }, callerHash);
}
