import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendDraft } from '../../graph/full-client.js';

export function registerGraphMessageSendDraft(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_message_send_draft',
    category: 'write_simple',
    annotations: {
      title: 'Send an existing draft message',
      description: 'Send a previously saved draft message from the COO mailbox via POST /users/{sender}/messages/{id}/send. Use graph_create_draft to create the draft first. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      message_id: z.string().describe('The Graph draft message ID to send.'),
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
          summary: `DRY RUN: would send draft ${input.message_id}. Pass dry_run=false to apply.`,
        };
      }
      await sendDraft(input.message_id);
      return {
        data: { executed: true, dry_run: false, message_id: input.message_id },
        audit: { before: null, after: input },
        summary: `Draft ${input.message_id} sent successfully.`,
      };
    },
  }, callerHash);
}
