import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteMessage } from '../../twilio/full-client.js';

export function registerTwilioMessageDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_message_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Twilio message',
      description: 'Permanently deletes a Twilio message record by SID via DELETE /Accounts/{SID}/Messages/{MessageSid}.json. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_sid: z.string().min(1).describe('Twilio Message SID to delete (starts with SM or MM).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_sid: input.message_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete message ${input.message_sid}. Pass dry_run=false to apply.`,
        };
      }
      await deleteMessage(input.message_sid);
      return {
        data: { executed: true, dry_run: false, message_sid: input.message_sid },
        audit: { before: { message_sid: input.message_sid }, after: null },
        summary: `Deleted message ${input.message_sid}.`,
      };
    },
  }, callerHash);
}
