import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { redactMessageBody } from '../../twilio/full-client.js';

export function registerTwilioMessageRedact(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_message_redact',
    category: 'write_simple',
    annotations: {
      title: 'Redact Twilio message body',
      description: 'Overwrites the body of a Twilio message with an empty string (redaction) via POST /Accounts/{SID}/Messages/{MessageSid}.json with Body="". Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_sid: z.string().min(1).describe('Twilio Message SID to redact (starts with SM or MM).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message_sid: z.string(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, message_sid: input.message_sid, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would redact body of message ${input.message_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await redactMessageBody(input.message_sid);
      return {
        data: { executed: true, dry_run: false, message_sid: result.sid ?? input.message_sid, status: result.status ?? null },
        audit: { before: { message_sid: input.message_sid }, after: { body: '' } },
        summary: `Redacted body of message ${input.message_sid}.`,
      };
    },
  }, callerHash);
}
