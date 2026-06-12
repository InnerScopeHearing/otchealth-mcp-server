import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomers } from '../../stripe/api-client.js';

export function registerStripeListCustomers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_list_customers',
    category: 'read',
    annotations: {
      title: 'List Stripe customers',
      description: 'List customers in Stripe, optionally filtered by email.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      email: z.string().optional().describe('Filter by customer email.'),
    },
    outputShape: {
      customers: z.array(z.object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable(), created: z.string() })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listCustomers({ limit: input.limit ?? 10, email: input.email });
      const customers = (result.data ?? []).map((c: any) => ({
        id: c.id, email: c.email ?? null, name: c.name ?? null,
        created: new Date(c.created * 1000).toISOString(),
      }));
      return {
        data: { customers, count: customers.length, has_more: result.has_more ?? false },
        summary: `Found ${customers.length} customer(s).`,
      };
    },
  }, callerHash);
}
