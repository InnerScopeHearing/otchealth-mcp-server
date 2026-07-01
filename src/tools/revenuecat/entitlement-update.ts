import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateEntitlement } from '../../revenuecat/full-client.js';

export function registerRevenueCatEntitlementUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_entitlement_update',
    category: 'write_simple',
    annotations: {
      title: 'Update RevenueCat entitlement',
      description: 'Update an entitlement definition (display name etc). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      entitlement_id: z.string().describe('Entitlement ID'),
      display_name: z.string().optional().describe('New display name'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), entitlement: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, entitlement: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update entitlement ${input.entitlement_id}. Pass dry_run=false to apply.`,
        };
      }
      const entitlement = await updateEntitlement(input.project_id, input.entitlement_id, { display_name: input.display_name });
      return {
        data: { executed: true, dry_run: false, entitlement },
        audit: { before: null, after: input },
        summary: `Entitlement ${input.entitlement_id} updated.`,
      };
    },
  }, callerHash);
}
