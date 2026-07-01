import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessageMedia } from '../../twilio/full-client.js';

export function registerTwilioMessageListMedia(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_message_list_media',
    category: 'read',
    annotations: {
      title: 'List Twilio message media',
      description: 'Lists all media resources attached to a Twilio MMS message via GET /Accounts/{SID}/Messages/{MessageSid}/Media.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      message_sid: z.string().min(1).describe('Twilio Message SID (starts with SM or MM).'),
    },
    outputShape: {
      media: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const media = await listMessageMedia(input.message_sid);
      return {
        data: { media, count: media.length },
        summary: `Found ${media.length} media item(s) for message ${input.message_sid}.`,
      };
    },
  }, callerHash);
}
