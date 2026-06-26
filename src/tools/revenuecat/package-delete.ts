import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deletePackage } from '../../revenuecat/full-client.js';

export function registerRevenueCatPackageDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_package_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete RevenueCat package',
      description: 'Permanently delete a package from an offering. IRREVERSIBLE. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Parent offering ID'),
      package_id: z.string().describe('Package ID to delete'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), deleted_id: z.string().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_id: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete package ${input.package_id}. Pass dry_run=false to apply.`,
        };
      }
      await deletePackage(input.project_id, input.offering_id, input.package_id);
      return {
        data: { executed: true, dry_run: false, deleted_id: input.package_id },
        audit: { before: null, after: input },
        summary: `Package ${input.package_id} deleted from offering ${input.offering_id}.`,
      };
    },
  }, callerHash);
}
