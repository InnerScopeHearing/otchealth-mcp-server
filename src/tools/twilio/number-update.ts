import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateIncomingPhoneNumber } from '../../twilio/full-client.js';

export function registerTwilioNumberUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Twilio phone number configuration',
      description: 'Updates routing configuration (friendly name, SMS/voice URLs, status callback) for an owned phone number via POST /Accounts/{SID}/IncomingPhoneNumbers/{PhoneSid}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      phone_sid: z.string().min(1).describe('Twilio IncomingPhoneNumber SID (starts with PN).'),
      friendly_name: z.string().optional().describe('New human-readable label for the number.'),
      sms_url: z.string().url().optional().describe('Webhook URL called when the number receives an SMS.'),
      voice_url: z.string().url().optional().describe('Webhook URL called when the number receives a call.'),
      status_callback: z.string().url().optional().describe('Webhook URL for status callbacks.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      phone_sid: z.string(),
      phone_number: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, phone_sid: input.phone_sid, phone_number: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update phone number ${input.phone_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await updateIncomingPhoneNumber(input.phone_sid, {
        friendly_name: input.friendly_name,
        sms_url: input.sms_url,
        voice_url: input.voice_url,
        status_callback: input.status_callback,
      });
      return {
        data: { executed: true, dry_run: false, phone_sid: result.sid ?? input.phone_sid, phone_number: result.phone_number ?? null },
        audit: { before: null, after: input },
        summary: `Updated phone number ${result.phone_number ?? input.phone_sid}.`,
      };
    },
  }, callerHash);
}
