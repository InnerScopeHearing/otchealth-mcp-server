import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getIncomingPhoneNumber } from '../../twilio/full-client.js';

export function registerTwilioNumberGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio incoming phone number',
      description: 'Fetches full details for an owned Twilio phone number by SID via GET /Accounts/{SID}/IncomingPhoneNumbers/{PhoneSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      phone_sid: z.string().min(1).describe('Twilio IncomingPhoneNumber SID (starts with PN).'),
    },
    outputShape: {
      sid: z.string(),
      phone_number: z.string(),
      friendly_name: z.string().nullable(),
      sms_url: z.string().nullable(),
      voice_url: z.string().nullable(),
    },
    handler: async (input) => {
      const num = await getIncomingPhoneNumber(input.phone_sid);
      return {
        data: {
          sid: num.sid,
          phone_number: num.phone_number,
          friendly_name: num.friendly_name ?? null,
          sms_url: num.sms_url ?? null,
          voice_url: num.voice_url ?? null,
        },
        summary: `Phone number ${num.phone_number} (${num.sid}).`,
      };
    },
  }, callerHash);
}
