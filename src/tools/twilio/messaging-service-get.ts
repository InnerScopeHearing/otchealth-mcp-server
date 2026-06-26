import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getMessagingService } from '../../twilio/full-client.js';

export function registerTwilioMessagingServiceGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_messaging_service_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio Messaging Service',
      description: 'Fetches full details of a Twilio Messaging Service by SID via GET /Accounts/{SID}/Services/{ServiceSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      service_sid: z.string().min(1).describe('Messaging Service SID (starts with MG).'),
    },
    outputShape: {
      sid: z.string(),
      friendly_name: z.string().nullable(),
      inbound_request_url: z.string().nullable(),
      fallback_url: z.string().nullable(),
      date_created: z.string().nullable(),
    },
    handler: async (input) => {
      const svc = await getMessagingService(input.service_sid);
      return {
        data: {
          sid: svc.sid,
          friendly_name: svc.friendly_name ?? null,
          inbound_request_url: svc.inbound_request_url ?? null,
          fallback_url: svc.fallback_url ?? null,
          date_created: svc.date_created ?? null,
        },
        summary: `Messaging Service ${svc.sid}: ${svc.friendly_name ?? '(no name)'}`,
      };
    },
  }, callerHash);
}
