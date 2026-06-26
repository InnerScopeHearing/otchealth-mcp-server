import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSubscriptionSchedules } from '../../stripe/full-client.js';

export function registerStripeSubscriptionScheduleList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_schedule_list',
    category: 'read',
    annotations: {
      title: 'List Stripe subscription schedules',
      description: 'List subscription schedules, optionally filtered by customer.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 10).'),
      customer: z.string().optional().describe('Filter by customer ID.'),
      starting_after: z.string().optional().describe('Cursor for pagination.'),
    },
    outputShape: {
      schedules: z.array(z.object({
        id: z.string(),
        status: z.string(),
        customer: z.string(),
        end_behavior: z.string(),
        current_phase: z.unknown().nullable(),
        created: z.string(),
      })),
      count: z.number(),
      has_more: z.boolean(),
    },
    handler: async (input, _ctx) => {
      const result = await listSubscriptionSchedules({
        limit: input.limit ?? 10,
        customer: input.customer,
        starting_after: input.starting_after,
      });
      const schedules = (result.data ?? []).map((s: any) => ({
        id: s.id,
        status: s.status,
        customer: s.customer,
        end_behavior: s.end_behavior,
        current_phase: s.current_phase ?? null,
        created: new Date(s.created * 1000).toISOString(),
      }));
      return {
        data: { schedules, count: schedules.length, has_more: result.has_more ?? false },
        summary: `Found ${schedules.length} subscription schedule(s).`,
      };
    },
  }, callerHash);
}
