import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRecording } from '../../twilio/full-client.js';

export function registerTwilioRecordingGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_recording_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio recording',
      description: 'Fetches metadata for a single recording by SID via GET /Accounts/{SID}/Recordings/{RecordingSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      recording_sid: z.string().min(1).describe('Twilio Recording SID (starts with RE).'),
    },
    outputShape: {
      sid: z.string(),
      call_sid: z.string().nullable(),
      status: z.string().nullable(),
      duration: z.string().nullable(),
      date_created: z.string().nullable(),
    },
    handler: async (input) => {
      const rec = await getRecording(input.recording_sid);
      return {
        data: {
          sid: rec.sid,
          call_sid: rec.call_sid ?? null,
          status: rec.status ?? null,
          duration: rec.duration ?? null,
          date_created: rec.date_created ?? null,
        },
        summary: `Recording ${rec.sid}: duration=${rec.duration}s, status=${rec.status}`,
      };
    },
  }, callerHash);
}
