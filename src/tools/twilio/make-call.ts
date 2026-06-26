import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { makeCall } from '../../twilio/write-client.js';

export function registerTwilioMakeCall(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'twilio_make_call',
      category: 'write_orchestrated',
      annotations: {
        title: 'Initiate outbound voice call via Twilio',
        description:
          'Initiates an outbound voice call via Twilio POST /Accounts/{SID}/Calls.json. ' +
          'TCPA-SENSITIVE: prior express written consent is required for marketing calls; ' +
          'prior express consent is required for informational calls. ' +
          'A TwiML URL (twiml_url) must be provided to define call behavior when answered. ' +
          'Requires ENABLE_HIGH_RISK_TOOLS. Defaults to dry_run.',
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
            'Destination phone number in E.164 format (e.g. +15005550006). ' +
            'TCPA: prior express written consent required for marketing; express consent for informational.',
          ),
        twiml_url: z
          .string()
          .url()
          .describe(
            'Publicly accessible URL that returns TwiML instructions for what to do when the call is answered. ' +
            'E.g. a Twilio Function, TwiML Bin URL, or your own webhook endpoint.',
          ),
        from: z
          .string()
          .optional()
          .describe(
            'Caller phone number in E.164 format. Defaults to TWILIO_FROM_NUMBER env var. ' +
            'Must be a voice-capable verified Twilio number.',
          ),
        status_callback: z
          .string()
          .url()
          .optional()
          .describe('Webhook URL to receive call status updates (initiated, ringing, answered, completed).'),
        status_callback_method: z
          .enum(['GET', 'POST'])
          .optional()
          .describe('HTTP method for the status callback. Default POST.'),
        timeout: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe('Seconds to let the call ring before treating as no-answer. Default 60.'),
        record: z
          .boolean()
          .optional()
          .describe(
            'If true, records the call. Ensure applicable call-recording consent laws are satisfied before enabling.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        to: z.string(),
        from: z.string().nullable(),
        call_sid: z.string().nullable(),
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
              call_sid: null,
              status: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would initiate a voice call to ${input.to} using TwiML from ${input.twiml_url}. ` +
              'Verify TCPA consent before applying. Pass dry_run=false to call.',
          };
        }

        const upstream = await makeCall({
          to: input.to,
          twiml_url: input.twiml_url,
          from: input.from,
          status_callback: input.status_callback,
          status_callback_method: input.status_callback_method,
          timeout: input.timeout,
          record: input.record,
          correlationId: ctx.correlationId,
        });

        return {
          data: {
            executed: true,
            dry_run: false,
            to: upstream.to,
            from: upstream.from,
            call_sid: upstream.sid,
            status: upstream.status,
          },
          audit: { before: null, after: input },
          summary: `Call initiated: SID ${upstream.sid}, status: ${upstream.status}.`,
        };
      },
    },
    callerHash,
  );
}
