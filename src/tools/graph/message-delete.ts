import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteMessage } from '../../graph/full-client.js';

export function registerGraphMessageDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Permanently delete an email message',
      description: 'Permanently delete a message from the COO mailbox via DELETE /users/{sender}/messages/{id}. This is irreversible — the message bypasses Deleted Items and is gone. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph message ID to delete permanently.'),
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
          summary: `DRY RUN: would permanently delete message ${input.message_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteMessage(input.message_id);
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id },
        audit: { before: { message_id: input.message_id }, after: null },
        summary: `Message ${input.message_id} permanently deleted.`,
      };
    },
  }, callerHash);
}
