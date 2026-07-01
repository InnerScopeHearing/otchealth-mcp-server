import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getConference } from '../../twilio/full-client.js';

export function registerTwilioConferenceGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio conference',
      description: 'Fetches details of a single conference by SID via GET /Accounts/{SID}/Conferences/{ConferenceSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conference_sid: z.string().min(1).describe('Twilio Conference SID (starts with CF).'),
    },
    outputShape: {
      sid: z.string(),
      friendly_name: z.string().nullable(),
      status: z.string().nullable(),
      date_created: z.string().nullable(),
    },
    handler: async (input) => {
      const conf = await getConference(input.conference_sid);
      return {
        data: {
          sid: conf.sid,
          friendly_name: conf.friendly_name ?? null,
          status: conf.status ?? null,
          date_created: conf.date_created ?? null,
        },
        summary: `Conference ${conf.sid}: status=${conf.status}`,
      };
    },
  }, callerHash);
}
