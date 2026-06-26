import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releasePhoneNumber } from '../../twilio/full-client.js';

export function registerTwilioNumberRelease(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_release',
    category: 'write_orchestrated',
    annotations: {
      title: 'Release (cancel) a Twilio phone number',
      description: 'Permanently releases an owned phone number back to Twilio via DELETE /Accounts/{SID}/IncomingPhoneNumbers/{PhoneSid}.json. Irreversible — the number may be assigned to another customer. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      phone_sid: z.string().min(1).describe('Twilio IncomingPhoneNumber SID to release (starts with PN).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      phone_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, phone_sid: input.phone_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would release phone number ${input.phone_sid}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      await releasePhoneNumber(input.phone_sid);
      return {
        data: { executed: true, dry_run: false, phone_sid: input.phone_sid },
        audit: { before: { phone_sid: input.phone_sid }, after: null },
        summary: `Released phone number ${input.phone_sid}. The number has been returned to Twilio.`,
      };
    },
  }, callerHash);
}
