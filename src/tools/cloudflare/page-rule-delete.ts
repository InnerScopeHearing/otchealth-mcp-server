import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deletePageRule } from '../../cloudflare/full-client.js';

export function registerCloudflarePageRuleDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_page_rule_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete page rule',
      description: 'Permanently delete a page rule. Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      rule_id: z.string().describe('Page rule ID to delete.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_rule_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_rule_id: input.rule_id },
          audit: { before: { rule_id: input.rule_id }, after: null },
          summary: `DRY RUN: would delete page rule ${input.rule_id}. Pass dry_run=false to apply.`,
        };
      }
      await deletePageRule(input.rule_id, input.zone_id);
      return {
        data: { executed: true, dry_run: false, deleted_rule_id: input.rule_id },
        audit: { before: { rule_id: input.rule_id }, after: null },
        summary: `Deleted page rule ${input.rule_id}.`,
      };
    },
  }, callerHash);
}
