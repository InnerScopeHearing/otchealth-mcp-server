import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSubscriptionSchedule } from '../../stripe/full-client.js';

export function registerStripeSubscriptionScheduleGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_schedule_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe subscription schedule',
      description: 'Retrieve a single subscription schedule by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      schedule_id: z.string().describe('Subscription schedule ID (sub_sched_...).'),
    },
    outputShape: {
      id: z.string(),
      status: z.string(),
      customer: z.string(),
      end_behavior: z.string(),
      phases: z.array(z.unknown()),
      created: z.string(),
    },
    handler: async (input, _ctx) => {
      const s = await getSubscriptionSchedule(input.schedule_id);
      return {
        data: {
          id: s.id,
          status: s.status,
          customer: s.customer,
          end_behavior: s.end_behavior,
          phases: s.phases ?? [],
          created: new Date(s.created * 1000).toISOString(),
        },
        summary: `Subscription schedule ${s.id}: ${s.status}.`,
      };
    },
  }, callerHash);
}
