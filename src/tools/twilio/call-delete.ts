import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCall } from '../../twilio/full-client.js';

export function registerTwilioCallDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Twilio call record',
      description: 'Permanently deletes a completed call record by SID via DELETE /Accounts/{SID}/Calls/{CallSid}.json. Irreversible. Only completed/failed calls can be deleted. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID to delete (starts with CA). Call must be in a terminal state.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      call_sid: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, call_sid: input.call_sid },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete call record ${input.call_sid}. Pass dry_run=false to apply.`,
        };
      }
      await deleteCall(input.call_sid);
      return {
        data: { executed: true, dry_run: false, call_sid: input.call_sid },
        audit: { before: { call_sid: input.call_sid }, after: null },
        summary: `Deleted call record ${input.call_sid}.`,
      };
    },
  }, callerHash);
}
