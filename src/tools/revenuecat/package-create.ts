import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPackage } from '../../revenuecat/full-client.js';

export function registerRevenueCatPackageCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_package_create',
    category: 'write_simple',
    annotations: {
      title: 'Create RevenueCat package',
      description: 'Create a new package within an offering. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Parent offering ID'),
      lookup_key: z.string().describe('Unique string key for the package'),
      display_name: z.string().optional().describe('Human-readable name'),
      position: z.number().int().optional().describe('Display order position'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), package: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, package: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create package "${input.lookup_key}" in offering ${input.offering_id}. Pass dry_run=false to apply.`,
        };
      }
      const pkg = await createPackage(input.project_id, input.offering_id, { lookup_key: input.lookup_key, display_name: input.display_name, position: input.position });
      return {
        data: { executed: true, dry_run: false, package: pkg },
        audit: { before: null, after: input },
        summary: `Package "${input.lookup_key}" created in offering ${input.offering_id}.`,
      };
    },
  }, callerHash);
}
