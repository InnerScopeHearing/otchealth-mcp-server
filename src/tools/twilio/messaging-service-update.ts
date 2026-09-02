import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateMessagingService } from '../../twilio/full-client.js';

export function registerTwilioMessagingServiceUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_messaging_service_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Twilio Messaging Service routing',
      description: 'Updates a Messaging Service\'s inbound request URL, fallback URL, delivery status callback and use_inbound_webhook_on_number via POST https://messaging.twilio.com/v1/Services/{ServiceSid}. Only the fields you pass are changed. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      service_sid: z.string().min(1).describe('Messaging Service SID (starts with MG).'),
      friendly_name: z.string().optional().describe('New human-readable label.'),
      inbound_request_url: z.string().url().optional().describe('Webhook for inbound messages to the service.'),
      inbound_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for inbound_request_url.'),
      fallback_url: z.string().url().optional().describe('Webhook Twilio calls when inbound_request_url fails.'),
      fallback_method: z.enum(['GET', 'POST']).optional().describe('HTTP method for fallback_url.'),
      status_callback: z.string().url().optional().describe('Delivery status callback URL for messages sent through the service.'),
      use_inbound_webhook_on_number: z.boolean().optional().describe('When true, inbound messages use each number\'s own SmsUrl instead of the service-level inbound_request_url.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      sid: z.string(),
      status_callback: z.string().nullable(),
      fallback_url: z.string().nullable(),
      use_inbound_webhook_on_number: z.boolean().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, sid: input.service_sid, status_callback: null, fallback_url: null, use_inbound_webhook_on_number: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update Messaging Service ${input.service_sid}. Pass dry_run=false to apply.`,
        };
      }
      const { service_sid, ...fields } = input;
      const svc = await updateMessagingService(service_sid, fields);
      return {
        data: {
          executed: true,
          dry_run: false,
          sid: svc.sid ?? service_sid,
          status_callback: svc.status_callback ?? null,
          fallback_url: svc.fallback_url ?? null,
          use_inbound_webhook_on_number: typeof svc.use_inbound_webhook_on_number === 'boolean' ? svc.use_inbound_webhook_on_number : null,
        },
        audit: { before: null, after: input },
        summary: `Updated Messaging Service ${svc.sid ?? service_sid}.`,
      };
    },
  }, callerHash);
}
