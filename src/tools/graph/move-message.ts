import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { moveMessage } from '../../graph/write-client.js';

export function registerGraphMoveMessage(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_move_message',
    category: 'write_simple',
    annotations: {
      title: 'Move a COO mailbox message to a folder',
      description: 'Move a message to a well-known folder (deleteditems, archive, junkemail, inbox, etc.) or a folder id via Microsoft Graph POST /users/{sender}/messages/{id}/move. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message id to move (from graph_list_messages).'),
      destination_id: z.string().describe('Well-known folder name (deleteditems, archive, junkemail, inbox, drafts, sentitems) or a folder id.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_id: z.string(),
      destination_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_id: input.message_id, destination_id: input.destination_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would move message ${input.message_id} to folder "${input.destination_id}". Pass dry_run=false to apply.`,
        };
      }
      const result = await moveMessage({ messageId: input.message_id, destinationId: input.destination_id });
      return {
        data: { executed: true, dry_run: false, message_id: result.id, destination_id: result.destinationId },
        audit: { before: null, after: input },
        summary: `Message ${result.id} moved to folder "${result.destinationId}".`,
      };
    },
  }, callerHash);
}
