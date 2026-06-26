import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { grantEntitlement } from '../../revenuecat/write-client.js';

export function registerRevenueCatGrantEntitlement(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_grant_entitlement',
    category: 'write_orchestrated',
    annotations: {
      title: 'Grant RevenueCat promotional entitlement',
      description:
        'Grant a promotional entitlement to a RevenueCat subscriber (POST v2 grant_promotional). This gives a subscriber free access to a paid entitlement for a specified duration. High-risk: affects billing/access. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z
        .string()
        .min(1)
        .describe('RevenueCat project ID (from revenuecat_list_projects).'),
      subscriber_id: z
        .string()
        .min(1)
        .describe('RevenueCat subscriber ID (app_user_id or RC-assigned id).'),
      entitlement_id: z
        .string()
        .min(1)
        .describe('RevenueCat entitlement identifier (e.g. "premium", "pro_annual").'),
      duration: z
        .enum(['daily', 'weekly', 'monthly', 'two_month', 'three_month', 'six_month', 'yearly', 'lifetime'])
        .describe('Duration of the promotional grant.'),
      start_time_ms: z
        .number()
        .optional()
        .describe('Unix timestamp in milliseconds when the grant starts. Defaults to now.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      subscriber_id: z.string(),
      entitlement_id: z.string(),
      duration: z.string(),
      upstream_response: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false,
            dry_run: true,
            project_id: input.project_id,
            subscriber_id: input.subscriber_id,
            entitlement_id: input.entitlement_id,
            duration: input.duration,
            upstream_response: null,
          },
          audit: { before: null, after: { entitlement_id: input.entitlement_id, duration: input.duration } },
          summary: `DRY RUN: would grant "${input.entitlement_id}" (${input.duration}) to subscriber "${input.subscriber_id}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await grantEntitlement({
        project_id: input.project_id,
        subscriber_id: input.subscriber_id,
        entitlement_id: input.entitlement_id,
        duration: input.duration,
        start_time_ms: input.start_time_ms,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          project_id: input.project_id,
          subscriber_id: input.subscriber_id,
          entitlement_id: input.entitlement_id,
          duration: input.duration,
          upstream_response: upstream,
        },
        audit: { before: null, after: { entitlement_id: input.entitlement_id, duration: input.duration } },
        summary: `Granted entitlement "${input.entitlement_id}" (${input.duration}) to subscriber "${input.subscriber_id}".`,
      };
    },
  }, callerHash);
}
