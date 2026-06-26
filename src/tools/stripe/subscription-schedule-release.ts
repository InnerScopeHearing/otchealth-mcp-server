import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseSubscriptionSchedule } from '../../stripe/full-client.js';

export function registerStripeSubscriptionScheduleRelease(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_subscription_schedule_release',
    category: 'write_simple',
    annotations: {
      title: 'Release Stripe subscription schedule',
      description: 'Release a subscription schedule, converting it back to a regular subscription. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      schedule_id: z.string().describe('Subscription schedule ID (sub_sched_...) to release.'),
      preserve_cancel_date: z.boolean().optional().describe('Preserve the cancel_at date if set.'),
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
          summary: `DRY RUN: would release subscription schedule ${input.schedule_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await releaseSubscriptionSchedule(input.schedule_id, input.preserve_cancel_date);
      return {
        data: { executed: true, dry_run: false, schedule_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Released subscription schedule ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
