import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { revokeEntitlement } from '../../revenuecat/write-client.js';

export function registerRevenueCatRevokeEntitlement(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_revoke_entitlement',
    category: 'write_orchestrated',
    annotations: {
      title: 'Revoke RevenueCat promotional entitlement',
      description:
        'Revoke a promotional entitlement from a RevenueCat subscriber (POST v2 revoke_promotional). Immediately removes access granted by a prior promotional grant. High-risk: irreversible access removal. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
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
        .describe('RevenueCat entitlement identifier to revoke (e.g. "premium").'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      subscriber_id: z.string(),
      entitlement_id: z.string(),
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
            upstream_response: null,
          },
          audit: { before: null, after: { entitlement_id: input.entitlement_id } },
          summary: `DRY RUN: would revoke entitlement "${input.entitlement_id}" from subscriber "${input.subscriber_id}". Pass dry_run=false to apply.`,
        };
      }
      const upstream = await revokeEntitlement({
        project_id: input.project_id,
        subscriber_id: input.subscriber_id,
        entitlement_id: input.entitlement_id,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          project_id: input.project_id,
          subscriber_id: input.subscriber_id,
          entitlement_id: input.entitlement_id,
          upstream_response: upstream,
        },
        audit: { before: null, after: { entitlement_id: input.entitlement_id } },
        summary: `Revoked entitlement "${input.entitlement_id}" from subscriber "${input.subscriber_id}".`,
      };
    },
  }, callerHash);
}
