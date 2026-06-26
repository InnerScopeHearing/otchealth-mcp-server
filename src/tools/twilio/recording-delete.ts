import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteRecording } from '../../twilio/full-client.js';

export function registerTwilioRecordingDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_recording_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Twilio recording',
      description: 'Permanently deletes a call recording by SID via DELETE /Accounts/{SID}/Recordings/{RecordingSid}.json. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      recording_sid: z.string().min(1).describe('Twilio Recording SID to delete (starts with RE).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      recording_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, recording_sid: input.recording_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete recording ${input.recording_sid}. Pass dry_run=false to apply.`,
        };
      }
      await deleteRecording(input.recording_sid);
      return {
        data: { executed: true, dry_run: false, recording_sid: input.recording_sid },
        audit: { before: { recording_sid: input.recording_sid }, after: null },
        summary: `Deleted recording ${input.recording_sid}.`,
      };
    },
  }, callerHash);
}
