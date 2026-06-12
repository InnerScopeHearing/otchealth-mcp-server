import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getBalance } from '../../stripe/api-client.js';

export function registerStripeGetBalance(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_get_balance',
    category: 'read',
    annotations: {
      title: 'Get Stripe balance',
      description: 'Get the current Stripe account balance (available and pending).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      available: z.array(z.object({ amount: z.number(), currency: z.string() })),
      pending: z.array(z.object({ amount: z.number(), currency: z.string() })),
    },
    handler: async (_input, _ctx) => {
      const balance = await getBalance();
      return {
        data: {
          available: (balance.available ?? []).map((b: any) => ({ amount: b.amount / 100, currency: b.currency })),
          pending: (balance.pending ?? []).map((b: any) => ({ amount: b.amount / 100, currency: b.currency })),
        },
        summary: `Balance: ${(balance.available ?? []).map((b: any) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ')} available.`,
      };
    },
  }, callerHash);
}
