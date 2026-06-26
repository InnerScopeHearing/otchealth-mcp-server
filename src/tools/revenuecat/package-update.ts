import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updatePackage } from '../../revenuecat/full-client.js';

export function registerRevenueCatPackageUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_package_update',
    category: 'write_simple',
    annotations: {
      title: 'Update RevenueCat package',
      description: 'Update a package (display name, position). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Parent offering ID'),
      package_id: z.string().describe('Package ID'),
      display_name: z.string().optional().describe('New display name'),
      position: z.number().int().optional().describe('New display order position'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), package: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, package: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update package ${input.package_id}. Pass dry_run=false to apply.`,
        };
      }
      const pkg = await updatePackage(input.project_id, input.offering_id, input.package_id, { display_name: input.display_name, position: input.position });
      return {
        data: { executed: true, dry_run: false, package: pkg },
        audit: { before: null, after: input },
        summary: `Package ${input.package_id} updated.`,
      };
    },
  }, callerHash);
}
