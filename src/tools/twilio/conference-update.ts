import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateConference } from '../../twilio/full-client.js';

export function registerTwilioConferenceUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Twilio conference',
      description: 'Updates a conference (e.g. terminate it or play an announcement) via POST /Accounts/{SID}/Conferences/{ConferenceSid}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conference_sid: z.string().min(1).describe('Twilio Conference SID (starts with CF).'),
      status: z.enum(['completed']).optional().describe('Set to "completed" to terminate the conference.'),
      announce_url: z.string().url().optional().describe('URL of audio to play to all participants.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conference_sid: z.string(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conference_sid: input.conference_sid, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update conference ${input.conference_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await updateConference(input.conference_sid, {
        status: input.status,
        announce_url: input.announce_url,
      });
      return {
        data: { executed: true, dry_run: false, conference_sid: result.sid ?? input.conference_sid, status: result.status ?? null },
        audit: { before: null, after: input },
        summary: `Updated conference ${input.conference_sid}: status=${result.status}.`,
      };
    },
  }, callerHash);
}
