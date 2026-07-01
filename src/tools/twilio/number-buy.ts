import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { buyPhoneNumber } from '../../twilio/full-client.js';

export function registerTwilioNumberBuy(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_number_buy',
    category: 'write_orchestrated',
    annotations: {
      title: 'Buy a Twilio phone number',
      description: 'Purchases a phone number from Twilio inventory via POST /Accounts/{SID}/IncomingPhoneNumbers.json. Has monthly billing implications. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      phone_number: z.string().min(1).describe('E.164 phone number to purchase (e.g. +12025551234). Get available numbers with twilio_number_list_available first.'),
      friendly_name: z.string().optional().describe('Human-readable label for the number.'),
      sms_url: z.string().url().optional().describe('Webhook URL for incoming SMS.'),
      voice_url: z.string().url().optional().describe('Webhook URL for incoming calls.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      phone_number: z.string().nullable(),
      phone_sid: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, phone_number: input.phone_number, phone_sid: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would purchase ${input.phone_number}. This incurs monthly charges. Pass dry_run=false to apply.`,
        };
      }
      const result = await buyPhoneNumber(input);
      return {
        data: { executed: true, dry_run: false, phone_number: result.phone_number ?? null, phone_sid: result.sid ?? null },
        audit: { before: null, after: input },
        summary: `Purchased phone number ${result.phone_number} (SID: ${result.sid}).`,
      };
    },
  }, callerHash);
}
