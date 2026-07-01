import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteOffering } from '../../revenuecat/full-client.js';

export function registerRevenueCatOfferingDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_offering_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete RevenueCat offering',
      description: 'Permanently delete an offering. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Offering ID to delete'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deleted_id: z.string().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_id: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete offering ${input.offering_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteOffering(input.project_id, input.offering_id);
      return {
        data: { executed: true, dry_run: false, deleted_id: input.offering_id },
        audit: { before: null, after: input },
        summary: `Offering ${input.offering_id} deleted.`,
      };
    },
  }, callerHash);
}
