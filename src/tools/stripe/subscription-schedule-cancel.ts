import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelSubscriptionSchedule } from '../../stripe/full-client.js';

export function registerStripeSubscriptionScheduleCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_schedule_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Cancel Stripe subscription schedule',
      description: 'Cancel a subscription schedule and optionally its underlying subscription. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      schedule_id: z.string().describe('Subscription schedule ID (sub_sched_...) to cancel.'),
      invoice_now: z.boolean().optional().describe('Invoice immediately for remaining time.'),
      prorate: z.boolean().optional().describe('Prorate credits and charges.'),
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
          data: { executed: false, dry_run: true, schedule_id: input.schedule_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel subscription schedule ${input.schedule_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await cancelSubscriptionSchedule(input.schedule_id, input.invoice_now, input.prorate);
      return {
        data: { executed: true, dry_run: false, schedule_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Cancelled subscription schedule ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
