import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSubscriptionSchedule } from '../../stripe/full-client.js';

export function registerStripeSubscriptionScheduleCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_schedule_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create Stripe subscription schedule',
      description: 'Create a subscription schedule to automate future subscription changes. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      customer: z.string().optional().describe('Customer ID (cus_...) to schedule for.'),
      from_subscription: z.string().optional().describe('Create schedule from existing subscription ID.'),
      start_date: z.union([z.number().int(), z.literal('now')]).optional().describe('Start date as Unix timestamp or "now".'),
      end_behavior: z.enum(['cancel', 'release', 'none']).optional().describe('What happens when schedule ends.'),
      phases: z.array(z.object({
        items: z.array(z.object({
          price: z.string().describe('Price ID.'),
          quantity: z.number().int().min(1).optional(),
        })),
        iterations: z.number().int().min(1).optional().describe('Number of billing periods for this phase.'),
        coupon: z.string().optional(),
        trial: z.boolean().optional(),
      })).optional().describe('Schedule phases.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      schedule_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, schedule_id: null, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create subscription schedule for customer ${input.customer ?? '(from subscription)'}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createSubscriptionSchedule({
        customer: input.customer,
        from_subscription: input.from_subscription,
        start_date: input.start_date,
        end_behavior: input.end_behavior,
        phases: input.phases,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, schedule_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Created subscription schedule ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
