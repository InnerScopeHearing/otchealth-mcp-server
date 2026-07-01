import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { sendSms } from '../../twilio/write-client.js';

export function registerTwilioSendSms(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'twilio_send_sms',
      category: 'write_orchestrated',
      annotations: {
        title: 'Send outbound SMS via Twilio',
        description:
          'Sends an outbound SMS text message via Twilio POST /Accounts/{SID}/Messages.json. ' +
          'TCPA-SENSITIVE: must only send to recipients who have given prior express written consent. ' +
          'Requires ENABLE_HIGH_RISK_TOOLS. Uses TWILIO_FROM_NUMBER env as default sender or accepts explicit "from". ' +
          'Defaults to dry_run.',
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
        body: z
          .string()
          .min(1)
          .max(1600)
          .describe('SMS message text. Max 1600 characters (multi-segment messages will be split by carriers).'),
        from: z
          .string()
          .optional()
          .describe(
            'Sender phone number in E.164 format. Defaults to TWILIO_FROM_NUMBER env var. ' +
            'Must be a verified Twilio number or Messaging Service SID.',
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
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would send SMS to ${input.to}. Verify TCPA consent before applying. ` +
              'Pass dry_run=false to send.',
          };
        }

        const upstream = await sendSms({
          to: input.to,
          body: input.body,
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
          },
          audit: { before: null, after: input },
          summary: `SMS queued: SID ${upstream.sid}, status: ${upstream.status}.`,
        };
      },
    },
    callerHash,
  );
}
