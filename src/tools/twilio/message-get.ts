import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMessage } from '../../twilio/full-client.js';

export function registerTwilioMessageGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_message_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio message',
      description: 'Fetches full details of a single Twilio message by SID via GET /Accounts/{SID}/Messages/{MessageSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_sid: z.string().min(1).describe('Twilio Message SID (starts with SM or MM).'),
    },
    outputShape: {
      sid: z.string(),
      status: z.string(),
      to: z.string(),
      from: z.string(),
      body: z.string().nullable(),
      num_media: z.string().nullable(),
      date_created: z.string().nullable(),
    },
    handler: async (input) => {
      const msg = await getMessage(input.message_sid);
      return {
        data: {
          sid: msg.sid,
          status: msg.status,
          to: msg.to,
          from: msg.from,
          body: msg.body ?? null,
          num_media: msg.num_media ?? null,
          date_created: msg.date_created ?? null,
        },
        summary: `Message ${msg.sid}: status=${msg.status}, to=${msg.to}`,
      };
    },
  }, callerHash);
}
