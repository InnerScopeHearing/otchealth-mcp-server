import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { kickConferenceParticipant } from '../../twilio/full-client.js';

export function registerTwilioConferenceKickParticipant(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_kick_participant',
    category: 'write_orchestrated',
    annotations: {
      title: 'Kick participant from Twilio conference',
      description: 'Removes a participant from a live conference via DELETE /Accounts/{SID}/Conferences/{ConferenceSid}/Participants/{CallSid}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conference_sid: z.string().min(1).describe('Twilio Conference SID (starts with CF).'),
      call_sid: z.string().min(1).describe('Call SID of the participant to remove (starts with CA).'),
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
          summary: `DRY RUN: would kick participant ${input.call_sid} from conference ${input.conference_sid}. Pass dry_run=false to apply.`,
        };
      }
      await kickConferenceParticipant(input.conference_sid, input.call_sid);
      return {
        data: { executed: true, dry_run: false, conference_sid: input.conference_sid, call_sid: input.call_sid },
        audit: { before: { conference_sid: input.conference_sid, call_sid: input.call_sid }, after: null },
        summary: `Kicked participant ${input.call_sid} from conference ${input.conference_sid}.`,
      };
    },
  }, callerHash);
}
