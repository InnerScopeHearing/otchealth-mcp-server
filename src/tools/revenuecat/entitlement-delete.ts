import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteEntitlement } from '../../revenuecat/full-client.js';

export function registerRevenueCatEntitlementDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_entitlement_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete RevenueCat entitlement',
      description: 'Permanently delete an entitlement definition. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      entitlement_id: z.string().describe('Entitlement ID to delete'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deleted_id: z.string().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_id: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete entitlement ${input.entitlement_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteEntitlement(input.project_id, input.entitlement_id);
      return {
        data: { executed: true, dry_run: false, deleted_id: input.entitlement_id },
        audit: { before: null, after: input },
        summary: `Entitlement ${input.entitlement_id} deleted.`,
      };
    },
  }, callerHash);
}
