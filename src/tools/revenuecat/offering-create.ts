import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createOffering } from '../../revenuecat/full-client.js';

export function registerRevenueCatOfferingCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_offering_create',
    category: 'write_simple',
    annotations: {
      title: 'Create RevenueCat offering',
      description: 'Create a new offering in a project. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      lookup_key: z.string().describe('Unique string key for the offering'),
      display_name: z.string().optional().describe('Human-readable name'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), offering: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, offering: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create offering "${input.lookup_key}". Pass dry_run=false to apply.`,
        };
      }
      const offering = await createOffering(input.project_id, { lookup_key: input.lookup_key, display_name: input.display_name });
      return {
        data: { executed: true, dry_run: false, offering },
        audit: { before: null, after: input },
        summary: `Offering "${input.lookup_key}" created.`,
      };
    },
  }, callerHash);
}
