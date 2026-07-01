import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCall } from '../../twilio/full-client.js';

export function registerTwilioCallUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_update',
    category: 'write_orchestrated',
    annotations: {
      title: 'Update/modify in-progress Twilio call',
      description: 'Modifies an in-progress call (redirect TwiML, hang up, etc.) via POST /Accounts/{SID}/Calls/{CallSid}.json. TCPA-sensitive. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID (starts with CA).'),
      status: z.enum(['canceled', 'completed']).optional().describe('Set to "canceled" to cancel a queued/ringing call, or "completed" to hang up an in-progress call.'),
      url: z.string().url().optional().describe('New TwiML URL to redirect the in-progress call to.'),
      method: z.enum(['GET', 'POST']).optional().describe('HTTP method for the redirect URL (default POST).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      call_sid: z.string(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, call_sid: input.call_sid, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update call ${input.call_sid}. Pass dry_run=false to apply.`,
        };
      }
      const result = await updateCall(input.call_sid, {
        status: input.status,
        url: input.url,
        method: input.method,
      });
      return {
        data: { executed: true, dry_run: false, call_sid: result.sid ?? input.call_sid, status: result.status ?? null },
        audit: { before: null, after: input },
        summary: `Updated call ${input.call_sid}: status=${result.status}.`,
      };
    },
  }, callerHash);
}
