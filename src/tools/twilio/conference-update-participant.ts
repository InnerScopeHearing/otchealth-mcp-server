import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateConferenceParticipant } from '../../twilio/full-client.js';

export function registerTwilioConferenceUpdateParticipant(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_update_participant',
    category: 'write_simple',
    annotations: {
      title: 'Update Twilio conference participant',
      description: 'Mutes, holds, or toggles coaching for a conference participant via POST /Accounts/{SID}/Conferences/{ConferenceSid}/Participants/{CallSid}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conference_sid: z.string().min(1).describe('Twilio Conference SID (starts with CF).'),
      call_sid: z.string().min(1).describe('Call SID of the participant (starts with CA).'),
      muted: z.boolean().optional().describe('Set true to mute, false to unmute.'),
      hold: z.boolean().optional().describe('Set true to hold participant, false to unhold.'),
      coaching: z.boolean().optional().describe('Set true to enable coaching mode.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conference_sid: z.string(),
      call_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conference_sid: input.conference_sid, call_sid: input.call_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update participant ${input.call_sid} in conference ${input.conference_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await updateConferenceParticipant(input.conference_sid, input.call_sid, {
        muted: input.muted,
        hold: input.hold,
        coaching: input.coaching,
      });
      return {
        data: { executed: true, dry_run: false, conference_sid: input.conference_sid, call_sid: result.call_sid ?? input.call_sid },
        audit: { before: null, after: input },
        summary: `Updated participant ${input.call_sid} in conference ${input.conference_sid}.`,
      };
    },
  }, callerHash);
}
