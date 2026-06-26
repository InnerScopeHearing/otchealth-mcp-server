import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateOffering } from '../../revenuecat/full-client.js';

export function registerRevenueCatOfferingUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_offering_update',
    category: 'write_simple',
    annotations: {
      title: 'Update RevenueCat offering',
      description: 'Update an offering (display name, current flag). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Offering ID'),
      display_name: z.string().optional().describe('New display name'),
      is_current: z.boolean().optional().describe('Set as the current default offering'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), offering: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, offering: undefined },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update offering ${input.offering_id}. Pass dry_run=false to apply.`,
        };
      }
      const offering = await updateOffering(input.project_id, input.offering_id, { display_name: input.display_name, is_current: input.is_current });
      return {
        data: { executed: true, dry_run: false, offering },
        audit: { before: null, after: input },
        summary: `Offering ${input.offering_id} updated.`,
      };
    },
  }, callerHash);
}
