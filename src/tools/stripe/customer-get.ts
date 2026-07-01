import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCustomer } from '../../stripe/full-client.js';

export function registerStripeCustomerGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_customer_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe customer',
      description: 'Retrieve a single customer by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().describe('Customer ID (cus_...).'),
    },
    outputShape: {
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      description: z.string().nullable(),
      balance: z.number(),
      created: z.string(),
      default_source: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const c = await getCustomer(input.customer_id);
      return {
        data: {
          id: c.id,
          email: c.email ?? null,
          name: c.name ?? null,
          phone: c.phone ?? null,
          description: c.description ?? null,
          balance: c.balance ?? 0,
          created: new Date(c.created * 1000).toISOString(),
          default_source: c.default_source ?? null,
        },
        summary: `Customer ${c.id}: ${c.email ?? c.name ?? '(no email/name)'}.`,
      };
    },
  }, callerHash);
}
