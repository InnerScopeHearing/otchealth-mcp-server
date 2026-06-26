import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listConferenceParticipants } from '../../twilio/full-client.js';

export function registerTwilioConferenceListParticipants(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_conference_list_participants',
    category: 'read',
    annotations: {
      title: 'List Twilio conference participants',
      description: 'Lists all participants in a conference via GET /Accounts/{SID}/Conferences/{ConferenceSid}/Participants.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conference_sid: z.string().min(1).describe('Twilio Conference SID (starts with CF).'),
      page_size: z.number().int().min(1).max(100).optional().describe('Number of results (default 20, max 100).'),
    },
    outputShape: {
      participants: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const participants = await listConferenceParticipants(input.conference_sid, input.page_size);
      return {
        data: { participants, count: participants.length },
        summary: `Found ${participants.length} participant(s) in conference ${input.conference_sid}.`,
      };
    },
  }, callerHash);
}
