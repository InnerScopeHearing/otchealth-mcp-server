import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBalance } from '../../twilio/api-client.js';

export function registerTwilioGetBalance(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'twilio_get_balance', category: 'read',
    annotations: { title: 'Get Twilio balance', description: 'Returns the current Twilio account balance and currency. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {}, outputShape: { currency: z.string(), balance: z.string() },
    handler: async () => { const b = await getBalance(); return { data: { currency: b.currency, balance: b.balance }, summary: `Twilio balance: ${b.balance} ${b.currency}` }; },
  }, callerHash);
}
