import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendMms } from '../../twilio/write-client.js';

export function registerTwilioSendMms(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'twilio_send_mms',
      category: 'write_orchestrated',
      annotations: {
        title: 'Send outbound MMS (media message) via Twilio',
        description:
          'Sends an outbound MMS message with one or more media attachments via Twilio POST /Accounts/{SID}/Messages.json. ' +
          'TCPA-SENSITIVE: must only send to recipients who have given prior express written consent. ' +
          'Media URLs must be publicly accessible. Requires ENABLE_HIGH_RISK_TOOLS. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        to: z
          .string()
          .min(1)
          .describe(
            'Destination phone number in E.164 format (e.g. +15005550006). Must have prior express written consent (TCPA).',
          ),
        media_url: z
          .array(z.string().url())
          .min(1)
          .max(10)
          .describe(
            'One or more publicly accessible media URLs to attach (images, GIFs, etc.). Max 10 per message. ' +
            'Supported formats: image/jpeg, image/png, image/gif, video/mp4, etc.',
          ),
        body: z
          .string()
          .max(1600)
          .optional()
          .describe('Optional text body to accompany the media. Max 1600 characters.'),
        from: z
          .string()
          .optional()
          .describe(
            'Sender phone number in E.164 format. Defaults to TWILIO_FROM_NUMBER env var. ' +
            'Must be an MMS-capable Twilio number.',
          ),
        status_callback: z
          .string()
          .url()
          .optional()
          .describe('Webhook URL to receive delivery status callbacks from Twilio.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        to: z.string(),
        from: z.string().nullable(),
        message_sid: z.string().nullable(),
        status: z.string().nullable(),
        media_count: z.number(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              to: input.to,
              from: input.from ?? null,
              message_sid: null,
              status: null,
              media_count: input.media_url.length,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would send MMS with ${input.media_url.length} media item(s) to ${input.to}. ` +
              'Verify TCPA consent before applying. Pass dry_run=false to send.',
          };
        }

        const upstream = await sendMms({
          to: input.to,
          body: input.body,
          media_url: input.media_url,
          from: input.from,
          status_callback: input.status_callback,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            to: upstream.to,
            from: upstream.from,
            message_sid: upstream.sid,
            status: upstream.status,
            media_count: input.media_url.length,
          },
          audit: { before: null, after: input },
          summary: `MMS queued: SID ${upstream.sid}, status: ${upstream.status}, media: ${input.media_url.length} item(s).`,
        };
      },
    },
    callerHash,
  );
}
