import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createEntitlement } from '../../revenuecat/full-client.js';

export function registerRevenueCatEntitlementCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_entitlement_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Create RevenueCat entitlement',
      description: 'Create a new entitlement definition. High-risk: affects access control. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      lookup_key: z.string().describe('Unique string key used to look up the entitlement in the SDK'),
      display_name: z.string().optional().describe('Human-readable display name'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), entitlement: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, entitlement: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create entitlement "${input.lookup_key}". Pass dry_run=false to apply.`,
        };
      }
      const entitlement = await createEntitlement(input.project_id, { lookup_key: input.lookup_key, display_name: input.display_name });
      return {
        data: { executed: true, dry_run: false, entitlement },
        audit: { before: null, after: input },
        summary: `Entitlement "${input.lookup_key}" created.`,
      };
    },
  }, callerHash);
}
