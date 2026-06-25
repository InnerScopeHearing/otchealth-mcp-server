import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMessages } from '../../twilio/api-client.js';

export function registerTwilioListMessages(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_list_messages', category: 'read',
    annotations: { title: 'List Twilio messages', description: 'List recent Twilio SMS/MMS messages on the account. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { limit: z.number().int().min(1).max(100).optional() },
    outputShape: { messages: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const msgs = await listMessages(input.limit ?? 20);
      const mapped = msgs.map((m: any) => ({
        sid: m.sid,
        from: m.from,
        to: m.to,
        status: m.status,
        direction: m.direction,
        dateSent: m.date_sent,
        body: (m.body || '').slice(0, 120),
      }));
      return { data: { messages: mapped, count: mapped.length }, summary: `${mapped.length} message(s)` };
    },
  }, callerHash);
}
