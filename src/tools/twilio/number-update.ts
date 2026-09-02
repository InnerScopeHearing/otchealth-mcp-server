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
      description: 'Updates routing configuration (friendly name, SMS/voice URLs + methods, status callback, voice/SMS FALLBACK URLs) for an owned phone number via POST /Accounts/{SID}/IncomingPhoneNumbers/{PhoneSid}.json. Only the fields you pass are changed. Defaults to dry_run.',
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
      status_callback_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for the status callback.'),
      sms_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for sms_url.'),
      voice_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for voice_url.'),
      voice_fallback_url: z.string().url().optional().describe('Webhook Twilio calls when voice_url fails or returns invalid TwiML.'),
      voice_fallback_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for voice_fallback_url.'),
      sms_fallback_url: z.string().url().optional().describe('Webhook Twilio calls when sms_url fails or returns invalid TwiML.'),
      sms_fallback_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for sms_fallback_url.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      phone_sid: z.string(),
      phone_number: z.string().nullable(),
      voice_fallback_url: z.string().nullable(),
      sms_fallback_url: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, phone_sid: input.phone_sid, phone_number: null, voice_fallback_url: null, sms_fallback_url: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update phone number ${input.phone_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await updateIncomingPhoneNumber(input.phone_sid, {
        friendly_name: input.friendly_name,
        sms_url: input.sms_url,
        sms_method: input.sms_method,
        voice_url: input.voice_url,
        voice_method: input.voice_method,
        status_callback: input.status_callback,
        status_callback_method: input.status_callback_method,
        voice_fallback_url: input.voice_fallback_url,
        voice_fallback_method: input.voice_fallback_method,
        sms_fallback_url: input.sms_fallback_url,
        sms_fallback_method: input.sms_fallback_method,
      });
      return {
        data: { executed: true, dry_run: false, phone_sid: result.sid ?? input.phone_sid, phone_number: result.phone_number ?? null, voice_fallback_url: result.voice_fallback_url ?? null, sms_fallback_url: result.sms_fallback_url ?? null },
        audit: { before: null, after: input },
        summary: `Updated phone number ${result.phone_number ?? input.phone_sid}.`,
      };
    },
  }, callerHash);
}
