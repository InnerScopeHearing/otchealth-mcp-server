import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCall } from '../../twilio/full-client.js';

export function registerTwilioCallGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_call_get',
    category: 'read',
    annotations: {
      title: 'Get Twilio call',
      description: 'Fetches full details of a single Twilio call by SID via GET /Accounts/{SID}/Calls/{CallSid}.json. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      call_sid: z.string().min(1).describe('Twilio Call SID (starts with CA).'),
    },
    outputShape: {
      sid: z.string(),
      status: z.string(),
      to: z.string(),
      from: z.string(),
      direction: z.string(),
      duration: z.string().nullable(),
      date_created: z.string().nullable(),
    },
    handler: async (input) => {
      const call = await getCall(input.call_sid);
      return {
        data: {
          sid: call.sid,
          status: call.status,
          to: call.to,
          from: call.from,
          direction: call.direction,
          duration: call.duration ?? null,
          date_created: call.date_created ?? null,
        },
        summary: `Call ${call.sid}: status=${call.status}, direction=${call.direction}`,
      };
    },
  }, callerHash);
}
